const express = require("express");
const cors = require("cors");
const pool = require("./db");
const { SerialPort } = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");

const app = express();

// CONFIGURAÇÃO DE CORS (Totalmente aberta para testes)
app.use(cors({
    origin: true, 
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true
}));

app.use(express.json());
app.use(express.static('.'));

// Variáveis de controle
let inicioAula = null; 
let ultimaTagLida = null;
const ocupandoSensor = {}; 

// =======================================================
// 1. CONFIGURAÇÃO TOLERANTE A FALHAS DA SERIAL (ARDUINO)
// =======================================================
let portaArduino = null;
let parser = null;

try {
    portaArduino = new SerialPort({
        path: "/dev/ttyACM0", 
        baudRate: 9600
    });

    parser = portaArduino.pipe(new ReadlineParser({ delimiter: '\n' }));

    portaArduino.on("open", () => console.log("Arduino conectado com sucesso na Raspberry."));
    portaArduino.on("error", (err) => console.log(`[AVISO SERIAL] Modo simulação ativo. Arduino não detectado: ${err.message}`));

    // Escutando o Arduino real
    parser.on("data", async (linha) => {
        try {
            const texto = linha.trim();
            if (!texto.startsWith("{")) return; 

            const dados = JSON.parse(texto);
            if (dados.uid && dados.distancia !== undefined) {
                await processarLeitura(dados.uid, dados.distancia);
            }
        } catch (error) {
            console.error("Erro ao processar dados seriais:", error.message);
        }
    });

} catch (error) {
    console.log("[AVISO] Rodando sem Arduino. Use o Postman para simular leituras.");
}

function enviarComando(comando) {
    const json = JSON.stringify({ comando }) + "\n";
    
    if (portaArduino && portaArduino.isOpen) {
        portaArduino.write(json, (err) => {
            if (err) console.error("Erro ao enviar comando:", err.message);
            else console.log("Comando enviado pro Arduino:", json.trim());
        });
    } else {
        console.log(`[SIMULADOR DE HARDWARE] O Arduino piscaria/apitaria agora -> COMANDO: ${comando}`);
    }
}

// =======================================================
// 2. LÓGICA CENTRAL CORRIGIDA
// =======================================================
async function processarLeitura(uid, distancia) {
    // Registra a última tag lida para a rota de status de cadastro
    ultimaTagLida = { uid };

    // Print no console para ver a leitura física em tempo real
    console.log(`[HARDWARE] Arduino leu a Tag: ${uid} | Distância: ${distancia}cm`);

    // Regra de Saída
    if (distancia > 30) {
        if (ocupandoSensor[uid]) {
            console.log(`[SAÍDA] Aluno ${uid} se afastou do sensor.`);
            delete ocupandoSensor[uid];
        }
        return { acao: "afastou", uid };
    }

    // CORREÇÃO DA REGRA DE APROXIMAÇÃO: Incluído o ">= 0" para aceitar a leitura do sensor colado
    if (distancia >= 0 && distancia < 10) {
        if (ocupandoSensor[uid]) return { acao: "ignorado_ja_ocupando", uid }; 

        const alunoCheck = await pool.query(`SELECT id, nome FROM alunos WHERE uid = $1`, [uid]);

        if (alunoCheck.rows.length === 0) {
            enviarComando("NEGADO");
            return { acao: "negado", uid, motivo: "Aluno não cadastrado" };
        }

        ocupandoSensor[uid] = true;
        console.log(`[VALIDADO] Aluno ${alunoCheck.rows[0].nome}. Registrando...`);
        const registro = await registrarPresencaMecanismo(uid);
        
        return { acao: "validado", uid, registro };
    }

    return { acao: "intermediario", uid, distancia };
}

async function registrarPresencaMecanismo(uid) {
    if (!inicioAula) {
        console.log("Tentativa de registro antes de iniciar a aula.");
        enviarComando("NEGADO");
        return { erro: "Aula não iniciada" };
    }

    const segundos = Math.floor((Date.now() - inicioAula) / 1000);
    const faltas = Math.min(Math.floor(segundos / 25), 4);
    
    // Alinhado com o frontend: Se tem mais de 0 blocos de atraso, calcula o status proporcional
    const status = faltas === 0 ? "PRESENTE" : "ATRASADO";

    // CORREÇÃO: Utilizando a coluna correta "data_registro" mapeada no seu Postgres
    await pool.query(
        `INSERT INTO presencas (uid, status, faltas, data_registro) VALUES ($1, $2, $3, NOW())`,
        [uid, status, faltas]
    );

    enviarComando("APROVADO");
    return { uid, status, faltas };
}

// =======================================================
// 3. ROTAS DA API
// =======================================================

app.post("/simulador/sensor", async (req, res) => {
    try {
        const { uid, distancia } = req.body;
        if (!uid || distancia === undefined) {
            return res.status(400).json({ erro: "O body deve conter 'uid' e 'distancia'" });
        }
        const resultado = await processarLeitura(uid, distancia);
        res.json({ mensagem: "Leitura processada com sucesso", resultado });
    } catch (error) {
        res.status(500).json({ erro: error.message });
    }
});

app.post("/login", async (req, res) => {
    try {
        const { email, password } = req.body;
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
    enviarComando("MODO_CADASTRO");
    return res.status(200).json({ mensagem: "Comando de modo cadastro enviado!" });
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
    console.log(`[POSTMAN] Consultou a última Tag: ${ultimaTagLida ? ultimaTagLida.uid : "Nenhuma tag na memória"}`);
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
    if(parser) {
        const input = data.toString().trim();
        parser.emit("data", input + "\n");
    }
});

app.listen(3000, '0.0.0.0', () => {
    console.log("Servidor rodando na porta 3000 e aceitando conexões externas");
});