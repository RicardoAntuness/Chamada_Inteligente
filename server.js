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

// Lógica de controle estrita por afastamento físico completo
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
// 2. LÓGICA CENTRAL
// =======================================================
async function processarLeitura(uid, distancia) {
    ultimaTagLida = { uid };

    console.log(`[HARDWARE] Arduino leu a Tag: ${uid} | Distância: ${distancia}cm`);

    if (distancia > 30) {
        if (ocupandoSensor[uid] === true) {
            console.log(`[AFASTAMENTO DETECTADO] Aluno ${uid} movendo cartão para longe. Aguardando desobstrução completa...`);
            ocupandoSensor[uid] = "afastando"; 
        }
        return { acao: "afastando", uid };
    }

    if (distancia >= 0 && distancia < 10) {
        if (ocupandoSensor[uid]) {
            if (ocupandoSensor[uid] === "afastando") {
                ocupandoSensor[uid] = true; 
            }
            return { acao: "ignorado_nao_afastou_completamente", uid }; 
        }

        const alunoCheck = await pool.query(`SELECT id, nome FROM alunos WHERE uid = $1`, [uid]);

        if (alunoCheck.rows.length === 0) {
            enviarComando("NEGADO");
            return { acao: "negado", uid, motivo: "Aluno não cadastrado" };
        }

        ocupandoSensor[uid] = true;
        
        console.log(`[VALIDADO] Aluno ${alunoCheck.rows[0].nome}. Processando registro...`);
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

    try {
        const registroExistente = await pool.query(
            "SELECT * FROM presencas WHERE uid = $1 ORDER BY id DESC LIMIT 1",
            [uid]
        );

        // SE JÁ EXISTE REGISTRO: Significa que ele está batendo SAÍDA
        if (registroExistente.rows.length > 0) {
            const registroAtual = registroExistente.rows[0];

            // Se o último status já for "SAIU", alterna de volta para PRESENTE/ATRASADO (re-entrada)
            if (registroAtual.status === "SAIU") {
                const segundos = Math.floor((Date.now() - inicioAula) / 1000);
                const faltas = Math.min(Math.floor(segundos / 25), 4);
                const status = faltas === 0 ? "PRESENTE" : "ATRASADO";

                await pool.query(
                    "UPDATE presencas SET status = $1, faltas = $2 WHERE id = $3",
                    [status, faltas, registroAtual.id]
                );
                console.log(`[RE-ENTRADA] Aluno ${uid} mudou status para ${status}.`);
                enviarComando("APROVADO");
                
                delete ocupandoSensor[uid];
                return { uid, status, faltas };
            }

            // IMPLEMENTAÇÃO RIGOROSA DA SAÍDA ACUMULATIVA:
            // 1. Mapeia quantas faltas o aluno gera puramente pelo momento que resolveu ir embora (Abandono)
            const segundosPresente = Math.floor((Date.now() - inicioAula) / 1000);
            let faltasPeloAbandono = 0;

            if (segundosPresente < 25) {
                faltasPeloAbandono = 4; // Abandonou no Bloco 1 -> Perdeu os 4 blocos da aula
            } else if (segundosPresente < 50) {
                faltasPeloAbandono = 3; // Abandonou no Bloco 2 -> Perdeu 3 blocos
            } else if (segundosPresente < 75) {
                faltasPeloAbandono = 2; // Abandonou no Bloco 3 -> Perdeu 2 blocos (Bloco 3 e 4)
            } else if (segundosPresente < 100) {
                faltasPeloAbandono = 1; // Abandonou no Bloco 4 -> Perdeu 1 bloco (Bloco 4)
            } else {
                faltasPeloAbandono = 0; // Ficou até o término completo da aula
            }

            // 2. Soma as faltas do atraso inicial (já salvas no banco) com as novas do abandono precoce
            let faltasTotaisAtualizadas = Math.min(registroAtual.faltas + faltasPeloAbandono, 4);

            await pool.query(
                "UPDATE presencas SET status = $1, faltas = $2 WHERE id = $3",
                ["SAIU", faltasTotaisAtualizadas, registroAtual.id]
            );

            console.log(`[SAÍDA ACUMULATIVA] Aluno ${uid} saiu. Atraso Entrada: ${registroAtual.faltas} | Falta Abandono: ${faltasPeloAbandono} | Total Final: ${faltasTotaisAtualizadas}`);
            enviarComando("APROVADO"); 

            delete ocupandoSensor[uid];
            return { uid, status: "SAIU", faltas: faltasTotaisAtualizadas };
        }

        // SE NÃO EXISTE REGISTRO: É a primeira batida (ENTRADA)
        const segundos = Math.floor((Date.now() - inicioAula) / 1000);
        const faltas = Math.min(Math.floor(segundos / 25), 4);
        const status = faltas === 0 ? "PRESENTE" : "ATRASADO";

        await pool.query(
            `INSERT INTO presencas (uid, status, faltas, data_registro) VALUES ($1, $2, $3, NOW())`,
            [uid, status, faltas]
        );

        console.log(`[ENTRADA] Aluno ${uid} registrado como ${status}.`);
        enviarComando("APROVADO");

        delete ocupandoSensor[uid];
        return { uid, status, faltas };

    } catch (error) {
        console.error("Erro no mecanismo de presença/saída:", error.message);
        enviarComando("NEGADO");
        throw error;
    }
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

app.post("/aula/iniciar", async (req, res) => {
    try {
        await pool.query("TRUNCATE TABLE presencas RESTART IDENTITY CASCADE;");
        
        for (let key in ocupandoSensor) {
            if (ocupandoSensor.hasOwnProperty(key)) {
                delete ocupandoSensor[key];
            }
        }

        inicioAula = Date.now();
        console.log("Banco de presenças limpo. Aula iniciada em:", new Date(inicioAula).toLocaleTimeString());
        
        res.json({ mensagem: "Aula iniciada com sucesso! Leituras anteriores foram limhas.", inicio: inicioAula });
    } catch (error) {
        console.error("Erro ao iniciar nova aula no banco:", error.message);
        res.status(500).json({ erro: "Falha ao limpar o histórico para iniciar a nova aula." });
    }
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