const express = require("express");
const cors = require("cors");
const pool = require("./db");

const app = express();

app.use(express.json());
app.use(cors());

const inicioAula = Date.now();

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

        res.json({
            uid,
            status,
            faltas
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            erro: error.message
        });
    }
});

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

app.listen(3000, () => {
    console.log("Servidor rodando na porta 3000");
});