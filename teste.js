const express = require("express");

const app = express();

app.use(express.json());

app.get("/ping", (req, res) => {
    console.log("PING RECEBIDO");
    res.send("pong");
});

app.post("/aula/iniciar", (req, res) => {
    console.log("AULA INICIADA");
    res.json({
        mensagem: "Aula iniciada com sucesso!",
        inicio: Date.now()
    });
});

app.get("/alunos", (req, res) => {
    res.json([
        {
            id: 1,
            nome: "Ricardo",
            uid: "123ABC"
        }
    ]);
});

app.listen(3000, "0.0.0.0", () => {
    console.log("Servidor de teste rodando na porta 3000");
});