const express = require("express");
const cors = require("cors");
const pool = require("./db");
const { SerialPort } = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");

const app = express();

app.use(express.json());
app.use(cors());

const inicioAula = Date.now();

// ===============================
// SERIAL ARDUINO
// ===============================

const portaArduino = new SerialPort({
    path: "/dev/ttyACM0", // Ajuste para a porta correta no seu Raspberry Pi
    baudRate: 9600
});

// O parser quebra o fluxo de dados bruto sempre que encontra uma nova linha (\n)
const parser = portaArduino.pipe(new ReadlineParser({ delimiter: '\n' }));

portaArduino.on("open", () => {
    console.log("Arduino conectado.");
});

portaArduino.on("error", (err) => {
    console.error("Erro Serial:", err.message);
});

/**
 * Envia um comando JSON para o Arduino via Serial
 * @param {string} comando - "APROVADO", "NEGADO", "MODO_CADASTRO", "CADASTRO_OK"
 */
function enviarComando(comando) {
    const json = JSON.stringify({ comando }) + "\n";

    portaArduino.write(json, (err) => {
        if (err) {
            console.error("Erro ao enviar comando:", err.message);
        } else {
            console.log("Comando enviado:", json.trim());
        }
    });
}

// ==========================================
// ESCUTANDO O ARDUINO E APLICANDO AS REGRAS
// ==========================================

parser.on("data", async (linha) => {
    try {
        // Remove espaços em branco e ignora mensagens de boot que não sejam JSON
        const texto = linha.trim();
        if (!texto.startsWith("{")) return; 

        const dados = JSON.parse(texto);
        console.log("Dados recebidos do Arduino:", dados);

        if (dados.uid) {
            const { uid, distancia } = dados;

            // 1. REGRA DA DISTÂNCIA
            if (distancia < 8 || distancia > 12) {
                console.log(`[NEGADO] Distância incorreta: ${distancia}cm.`);
                enviarComando("NEGADO"); // Arduino: Toca buzzer erro / LED vermelho
                return;
            }

            // 2. VERIFICA NO BANCO
            const alunoCheck = await pool.query(
                `SELECT id, nome FROM alunos WHERE uid = $1`, 
                [uid]
            );

            if (alunoCheck.rows.length === 0) {
                console.log(`[NEGADO] UID ${uid} não cadastrado.`);
                enviarComando("NEGADO"); // Arduino: Toca buzzer erro / LED vermelho
                return;
            }

            // 3. VALIDADO
            console.log(`[VALIDADO] Aluno ${alunoCheck.rows[0].nome}. Registrando...`);
            await registrarPresencaMecanismo(uid);
        }
    } catch (error) {
        console.error("Erro ao processar dados seriais:", error.message);
    }
});

async function registrarPresencaMecanismo(uid) {
    const segundos = Math.floor((Date.now() - inicioAula) / 1000);
    const faltas = Math.min(Math.floor(segundos / 25), 4);
    const status = faltas === 0 ? "PRESENTE" : "ATRASADO";

    await pool.query(
        `INSERT INTO presencas (uid, status, faltas) VALUES ($1, $2, $3)`,
        [uid, status, faltas]
    );

    enviarComando("APROVADO"); // Arduino: Toca buzzer sucesso / LED verde
    return { uid, status, faltas };
}

// ===============================
// ROTAS DE CADASTRO
// ===============================

app.post("/cadastro/iniciar", (req, res) => {
    enviarComando("MODO_CADASTRO"); // Arduino: Pisca LED amarelo
    res.json({ mensagem: "Arduino em modo de cadastro." });
});

app.post("/cadastro/salvar", async (req, res) => {
    try {
        const { uid, nome } = req.body;
        await pool.query(`INSERT INTO alunos (uid, nome) VALUES ($1, $2)`, [uid, nome]);
        
        enviarComando("CADASTRO_OK"); // Arduino: Piscas rápidas de confirmação
        res.json({ sucesso: true, mensagem: "Aluno cadastrado!" });
    } catch (error) {
        enviarComando("NEGADO");
        res.status(500).json({ erro: "Falha ao cadastrar." });
    }
});

// ===============================
// ROTA HTTP DE PRESENÇA
// ===============================

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

// ===============================
// LISTAR PRESENÇAS
// ===============================

app.get("/presencas", async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM presencas ORDER BY id DESC`);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ erro: error.message });
    }
});

// ===============================
// SIMULADOR DE ARDUINO (VIA TECLADO)
// ===============================
process.stdin.on("data", (data) => {
    const input = data.toString().trim();
    parser.emit("data", input + "\n");
});

app.listen(3000, () => {
    console.log("Servidor rodando na porta 3000");
});