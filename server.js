const express = require("express");
const cors = require("cors");
const pool = require("./db");
const { SerialPort } = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");

const app = express();

app.use(express.json());
app.use(cors());

const inicioAula = Date.now();
// Objeto para controle de tempo de leitura por UID (Cooldown de 5 segundos)
const cooldowns = {}; 

// ===============================
// SERIAL ARDUINO
// ===============================

const portaArduino = new SerialPort({
    path: "/dev/ttyACM0",
    baudRate: 9600
});

const parser = portaArduino.pipe(new ReadlineParser({ delimiter: '\n' }));

portaArduino.on("open", () => {
    console.log("Arduino conectado.");
});

portaArduino.on("error", (err) => {
    console.error("Erro Serial:", err.message);
});

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
        const texto = linha.trim();
        if (!texto.startsWith("{")) return; 

        const dados = JSON.parse(texto);
        
        if (dados.uid) {
            const { uid, distancia } = dados;

            // --- LÓGICA DE DEBOUNCE (5 segundos) ---
            const agora = Date.now();
            if (cooldowns[uid] && (agora - cooldowns[uid] < 5000)) {
                console.log(`[IGNORADO] Leitura rápida demais para o UID: ${uid}`);
                return; 
            }
            cooldowns[uid] = agora;
            // ---------------------------------------

            // 1. REGRA DA DISTÂNCIA
            if (distancia < 8 || distancia > 12) {
                console.log(`[NEGADO] Distância incorreta: ${distancia}cm.`);
                enviarComando("NEGADO");
                return;
            }

            // 2. VERIFICA NO BANCO
            const alunoCheck = await pool.query(
                `SELECT id, nome FROM alunos WHERE uid = $1`, 
                [uid]
            );

            if (alunoCheck.rows.length === 0) {
                console.log(`[NEGADO] UID ${uid} não cadastrado.`);
                enviarComando("NEGADO");
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

    enviarComando("APROVADO");
    return { uid, status, faltas };
}

// ===============================
// ROTAS DE CADASTRO
// ===============================

app.post("/cadastro/iniciar", (req, res) => {
    enviarComando("MODO_CADASTRO");
    res.json({ mensagem: "Arduino em modo de cadastro." });
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