const express = require("express");
const cors = require("cors");
const pool = require("./db");
const { SerialPort } = require("serialport");

const app = express();

app.use(express.json());
app.use(cors());

const inicioAula = Date.now();

// ===============================
// SERIAL ARDUINO
// ===============================

const portaArduino = new SerialPort({
    path: "/dev/ttyACM0", // ajuste se necessário
    baudRate: 9600
});

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

// ===============================
// PRESENÇA
// ===============================

app.post("/presenca", async (req, res) => {
    try {
        const { uid } = req.body;

        const segundos = Math.floor((Date.now() - inicioAula) / 1000);
        const faltas = Math.min(Math.floor(segundos / 25), 4);
        const status = faltas === 0 ? "PRESENTE" : "ATRASADO";

        await pool.query(
            `
            INSERT INTO presencas (uid, status, faltas)
            VALUES ($1, $2, $3)
            `,
            [uid, status, faltas]
        );

        // envia sinal para Arduino
        enviarComando("APROVADO");

        res.json({
            uid,
            status,
            faltas
        });

    } catch (error) {
        console.error(error);

        enviarComando("NEGADO");

        res.status(500).json({
            erro: error.message
        });
    }
});

// ===============================
// LISTAR PRESENÇAS
// ===============================

app.get("/presencas", async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT *
            FROM presencas
            ORDER BY id DESC
        `);

        res.json(result.rows);

    } catch (error) {
        console.error(error);

        res.status(500).json({
            erro: error.message
        });
    }
});

// ===============================
// COMANDOS MANUAIS PARA TESTE
// ===============================

app.post("/arduino/aprovado", (req, res) => {
    enviarComando("APROVADO");
    res.json({ ok: true });
});

app.post("/arduino/negado", (req, res) => {
    enviarComando("NEGADO");
    res.json({ ok: true });
});

app.post("/arduino/modo-cadastro", (req, res) => {
    enviarComando("MODO_CADASTRO");
    res.json({ ok: true });
});

app.post("/arduino/cadastro-ok", (req, res) => {
    enviarComando("CADASTRO_OK");
    res.json({ ok: true });
});


app.listen(3000, () => {
    console.log("Servidor rodando na porta 3000");
});