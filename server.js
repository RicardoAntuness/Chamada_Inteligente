const express = require("express");
const cors = require("cors");
const pool = require("./db");
const { SerialPort } = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");

const app = express();

// CONFIGURAÇÃO DE CORS - Cole exatamente isto:
app.use(cors({
    origin: "http://10.1.24.27:5177", // A porta exata do seu Vite
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true
}));

app.use(express.json());

// ... resto do seu código (rotas, etc) ...

// Variável mutável para controlar o início da aula
let inicioAula = null; 
let ultimaTagLida = null;
const ocupandoSensor = {}; 

// ===============================
// SERIAL ARDUINO
// ===============================

const portaArduino = new SerialPort({
    path: "/dev/ttyACM0", // <--- Padrão Linux para Arduino na Raspberry
    baudRate: 9600
});

const parser = portaArduino.pipe(new ReadlineParser({ delimiter: '\n' }));

portaArduino.on("open", () => console.log("Arduino conectado."));
portaArduino.on("error", (err) => console.error("Erro Serial:", err.message));

function enviarComando(comando) {
    const json = JSON.stringify({ comando }) + "\n";
    portaArduino.write(json, (err) => {
        if (err) console.error("Erro ao enviar comando:", err.message);
        else console.log("Comando enviado:", json.trim());
    });
}

// ==========================================
// ESCUTANDO O ARDUINO E APLICANDO AS REGRAS
// ==========================================

parser.on("data", async (linha) => {

    
    try {
        const texto = linha.trim();
        if (!texto.startsWith("{")) return; 

        const dados = JSON.parse(texto);
        
        if (dados.uid) {
            ultimaTagLida = { uid: dados.uid };
            const { uid, distancia } = dados;

            if (distancia > 30) {
                if (ocupandoSensor[uid]) {
                    console.log(`[SAÍDA] Aluno ${uid} se afastou.`);
                    delete ocupandoSensor[uid];
                }
                return;
            }

            if (distancia > 0 && distancia < 10) {
                if (ocupandoSensor[uid]) return; 

                const alunoCheck = await pool.query(
                    `SELECT id, nome FROM alunos WHERE uid = $1`, [uid]
                );

                if (alunoCheck.rows.length === 0) {
                    enviarComando("NEGADO");
                    return;
                }

                ocupandoSensor[uid] = true;
                console.log(`[VALIDADO] Aluno ${alunoCheck.rows[0].nome}. Registrando...`);
                await registrarPresencaMecanismo(uid);
            }
        }
    } catch (error) {
        console.error("Erro ao processar dados seriais:", error.message);
    }
});

async function registrarPresencaMecanismo(uid) {
    if (!inicioAula) {
        console.log("Tentativa de registro antes de iniciar a aula.");
        enviarComando("NEGADO");
        return { erro: "Aula não iniciada" };
    }

    const segundos = Math.floor((Date.now() - inicioAula) / 1000);
    const faltas = Math.min(Math.floor(segundos / 25), 4);
    const status = faltas === 0 ? "PRESENTE" : "ATRASADO";

    await pool.query(
        `INSERT INTO presencas (uid, status, faltas) VALUES ($1, $2, $3)`,
        [uid, status, faltas]
    );

    enviarComando("APROVADO");
    return { uid, status, faltas };
}

// ===============================
// ROTAS DE CADASTRO E PRESENÇA
// ===============================

app.post("/login", async (req, res) => {
    try {
        const { email, password } = req.body;
        
        // Exemplo: buscando no banco de dados (se você tiver uma tabela 'usuarios')
        // Se ainda não tiver tabela de usuários, adicione uma lógica de teste:
        if (email === "ana@escola.edu.br" && password === "aluno123") {
            res.json({ success: true, user: { name: "Ana Lima", role: "aluno" } });
        } else {
            res.status(401).json({ erro: "E-mail ou senha incorretos." });
        }
    } catch (error) {
        res.status(500).json({ erro: "Erro no servidor." });
    }
});

app.post("/aula/iniciar", (req, res) => {
    inicioAula = Date.now();
    console.log("Aula iniciada em:", new Date(inicioAula).toLocaleTimeString());
    res.json({ mensagem: "Aula iniciada com sucesso!", inicio: inicioAula });
});

app.post("/cadastro/iniciar", (req, res) => {
    console.log("Comando recebido: MODO_CADASTRO");
    
    // Dispara o comando serial sem aguardar o retorno
    portaArduino.write(JSON.stringify({ comando: "MODO_CADASTRO" }) + "\n", (err) => {
        if (err) console.error("Erro no write:", err.message);
    });
    
    // Responde AGORA para o navegador, para evitar o "pending"
    return res.status(200).json({ mensagem: "Comando enviado!" });
});

app.post("/cadastro/salvar", async (req, res) => {
    try {
        const { uid, nome } = req.body;
        await pool.query(`INSERT INTO alunos (uid, nome) VALUES ($1, $2)`, [uid, nome]);
        enviarComando("CADASTRO_OK");
        res.json({ sucesso: true, mensagem: "Aluno cadastrado!" });
    } catch (error) {
        enviarComando("NEGADO");
        res.status(500).json({ erro: "Falha ao cadastrar." });
    }
});

app.post("/presenca", async (req, res) => {
    try {
        const { uid } = req.body;
        const resultado = await registrarPresencaMecanismo(uid);
        res.json(resultado);
    } catch (error) {
        enviarComando("NEGADO");
        res.status(500).json({ erro: error.message });
    }
});

app.get("/cadastro/status", (req, res) => {
    res.json(ultimaTagLida || { uid: null });
    ultimaTagLida = null; 
});

app.get("/alunos", async (req, res) => {
    const result = await pool.query(`SELECT * FROM alunos`);
    res.json(result.rows);
});

app.get("/presencas", async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM presencas ORDER BY id DESC`);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ erro: error.message });
    }
});

process.stdin.on("data", (data) => {
    const input = data.toString().trim();
    parser.emit("data", input + "\n");
});

app.listen(3000, '0.0.0.0', () => {
    console.log("Servidor rodando na porta 3000 e aceitando conexões externas");
});