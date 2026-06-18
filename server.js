const express = require("express");
const cors = require("cors");
const pool = require("./db");
const { SerialPort } = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");

const app = express();

// CONFIGURAÇÃO DE CORS (Restrito aos métodos em uso pelo ecossistema)
app.use(cors({
    origin: true, 
    methods: ["GET", "POST"],
    credentials: true
}));

app.use(express.json());
app.use(express.static('.'));

// Variáveis de controle de estado global
let inicioAula = null; 
let ultimaTagLida = null;

// Lógica de controle estrita por afastamento físico completo
const ocupandoSensor = {}; 

// =======================================================
// 1. CONFIGURAÇÃO DA SERIAL (ARDUINO)
// =======================================================
let portaArduino = null;
let parser = null;

try {
    portaArduino = new SerialPort({
        path: "/dev/ttyACM0", 
        baudRate: 9600
    });

    parser = portaArduino.pipe(new ReadlineParser({ delimiter: '\n' }));

    portaArduino.on("open", () => console.log("[SYSTEM] Hardware Conectado: Arduino operacional na Raspberry Pi."));
    portaArduino.on("error", (err) => console.error(`[ERRO SERIAL] Falha crítica de conexão com o Arduino: ${err.message}`));

    // Escuta e processa as leituras via hardware
    parser.on("data", async (linha) => {
        try {
            const texto = linha.trim();
            if (!texto.startsWith("{")) return; 

            const dados = JSON.parse(texto);
            if (dados.uid && dados.distancia !== undefined) {
                await processarLeitura(dados.uid, dados.distancia);
            }
        } catch (error) {
            console.error("[HARDWARE] Erro ao processar dados seriais:", error.message);
        }
    });

} catch (error) {
    console.error("[SYSTEM] Erro crítico ao inicializar interface Serial:", error.message);
}

// Envia comandos de feedback visual/sonoro para o Arduino
function enviarComando(comando) {
    const json = JSON.stringify({ comando }) + "\n";
    
    if (portaArduino && portaArduino.isOpen) {
        portaArduino.write(json, (err) => {
            if (err) console.error("[HARDWARE] Erro ao enviar comando:", err.message);
            else console.log("[HARDWARE] Comando enviado pro Arduino:", json.trim());
        });
    }
}

// =======================================================
// 2. LÓGICA CENTRAL DE FLUXO E REGRAS DE NEGÓCIO
// =======================================================

// Filtra e valida a aproximação física da tag no sensor ultrassônico
async function processarLeitura(uid, distancia) {
    ultimaTagLida = { uid };

    console.log(`[HARDWARE] Leitura Capturada -> Tag: ${uid} | Distância: ${distancia}cm`);

    // Valida se o cartão foi completamente afastado do leitor
    if (distancia > 30) {
        if (ocupandoSensor[uid] === true) {
            console.log(`[AUDITORIA] Aluno ${uid} afastando cartão. Aguardando liberação do sensor.`);
            ocupandoSensor[uid] = "afastando"; 
        }
        return;
    }

    // Processa a aproximação intencional de presença
    if (distancia >= 0 && distancia < 10) {
        if (ocupandoSensor[uid]) {
            if (ocupandoSensor[uid] === "afastando") {
                ocupandoSensor[uid] = true; 
            }
            return; 
        }

        const alunoCheck = await pool.query(`SELECT id, nome FROM alunos WHERE uid = $1`, [uid]);

        if (alunoCheck.rows.length === 0) {
            enviarComando("NEGADO");
            console.log(`[AUDITORIA] Acesso Negado: Tag ${uid} não possui cadastro.`);
            return;
        }

        ocupandoSensor[uid] = true;
        
        console.log(`[AUDITORIA] Tag reconhecida com sucesso -> Aluno: ${alunoCheck.rows[0].nome}`);
        await registrarPresencaMecanismo(uid);
    }
}

// Calcula matematicamente os blocos de falta por entrada tardia ou abandono precoce
async function registrarPresencaMecanismo(uid) {
    if (!inicioAula) {
        console.log(`[AUDITORIA] Registro Rejeitado: Tentativa de leitura da Tag ${uid} antes do início formal da aula.`);
        enviarComando("NEGADO");
        return;
    }

    try {
        const registroExistente = await pool.query(
            "SELECT * FROM presencas WHERE uid = $1 ORDER BY id DESC LIMIT 1",
            [uid]
        );

        // FLUXO DE SAÍDA OU RE-ENTRADA DO ALUNO
        if (registroExistente.rows.length > 0) {
            const registroAtual = registroExistente.rows[0];

            // Re-entrada do aluno na sala de aula
            if (registroAtual.status === "SAIU") {
                const segundos = Math.floor((Date.now() - inicioAula) / 1000);
                const faltas = Math.min(Math.floor(segundos / 25), 4);
                const status = faltas === 0 ? "PRESENTE" : "ATRASADO";

                await pool.query(
                    "UPDATE presencas SET status = $1, faltas = $2 WHERE id = $3",
                    [status, faltas, registroAtual.id]
                );
                console.log(`[AUDITORIA] RE-ENTRADA: Aluno ${uid} retornou à aula. Status atualizado para: ${status} (Faltas: ${faltas}).`);
                enviarComando("APROVADO");
                
                delete ocupandoSensor[uid];
                return;
            }

            // Registro de Saída com cálculo acumulativo progressivo (Abandono)
            const segundosPresente = Math.floor((Date.now() - inicioAula) / 1000);
            let faltasPeloAbandono = 0;

            if (segundosPresente < 25) {
                faltasPeloAbandono = 4;
            } else if (segundosPresente < 50) {
                faltasPeloAbandono = 3;
            } else if (segundosPresente < 75) {
                faltasPeloAbandono = 2;
            } else if (segundosPresente < 100) {
                faltasPeloAbandono = 1;
            } else {
                faltasPeloAbandono = 0;
            }

            let faltasTotaisAtualizadas = Math.min(registroAtual.faltas + faltasPeloAbandono, 4);

            await pool.query(
                "UPDATE presencas SET status = $1, faltas = $2 WHERE id = $3",
                ["SAIU", faltasTotaisAtualizadas, registroAtual.id]
            );

            console.log(`[AUDITORIA] SAÍDA: Aluno ${uid} abandonou a sala. Atraso Entrada: ${registroAtual.faltas} | Penalidade Abandono: ${faltasPeloAbandono} | Total Acumulado: ${faltasTotaisAtualizadas}`);
            enviarComando("APROVADO"); 

            delete ocupandoSensor[uid];
            return;
        }

        // FLUXO DE PRIMEIRA ENTRADA DO ALUNO
        const segundos = Math.floor((Date.now() - inicioAula) / 1000);
        const faltas = Math.min(Math.floor(segundos / 25), 4);
        const status = faltas === 0 ? "PRESENTE" : "ATRASADO";

        await pool.query(
            `INSERT INTO presencas (uid, status, faltas, data_registro) VALUES ($1, $2, $3, NOW())`,
            [uid, status, faltas]
        );

        console.log(`[AUDITORIA] ENTRADA: Aluno ${uid} registrado com sucesso. Status: ${status} | Faltas Iniciais: ${faltas}`);
        enviarComando("APROVADO");

        delete ocupandoSensor[uid];

    } catch (error) {
        console.error("[DATABASE] Erro crítico no mecanismo de presença/saída:", error.message);
        enviarComando("NEGADO");
        throw error;
    }
}

// =======================================================
// 3. ROTAS ATIVAS DA API
// =======================================================

// Inicializa o cronômetro da aula corrente e reseta a tabela de presença diária
app.post("/aula/iniciar", async (req, res) => {
    try {
        await pool.query("TRUNCATE TABLE presencas RESTART IDENTITY CASCADE;");
        
        for (let key in ocupandoSensor) {
            if (ocupandoSensor.hasOwnProperty(key)) {
                delete ocupandoSensor[key];
            }
        }

        inicioAula = Date.now();
        console.log("[SYSTEM] Banco de presenças limpo. Nova aula iniciada às:", new Date(inicioAula).toLocaleTimeString());
        
        res.json({ mensagem: "Aula iniciada com sucesso! Leituras anteriores foram limpas.", inicio: inicioAula });
    } catch (error) {
        console.error("[DATABASE] Erro ao iniciar nova aula no banco:", error.message);
        res.status(500).json({ erro: "Falha ao limpar o histórico para iniciar a nova aula." });
    }
});

// Envia sinal ao hardware informando que o sistema aguarda uma nova tag para cadastro
app.post("/cadastro/iniciar", (req, res) => {
    console.log("[API] Comando recebido: MODO_CADASTRO acionado.");
    enviarComando("MODO_CADASTRO");
    return res.status(200).json({ mensagem: "Comando de modo cadastro enviado!" });
});

// Salva de forma persistente os dados de um novo aluno no banco de dados
app.post("/cadastro/salvar", async (req, res) => {
    try {
        const { uid, nome } = req.body;
        await pool.query(`INSERT INTO alunos (uid, nome) VALUES ($1, $2)`, [uid, nome]);
        enviarComando("CADASTRO_OK");
        console.log(`[DATABASE] Novo aluno registrado -> Nome: ${nome} | Tag: ${uid}`);
        res.json({ sucesso: true, mensagem: "Aluno cadastrado!" });
    } catch (error) {
        enviarComando("NEGADO");
        console.error("[DATABASE] Falha ao cadastrar aluno:", error.message);
        res.status(500).json({ erro: "Falha ao cadastrar." });
    }
});

// Polling do Frontend: Consulta a memória em busca da última tag lida para popular os inputs de cadastro
app.get("/cadastro/status", (req, res) => {
    res.json(ultimaTagLida || { uid: null });
    ultimaTagLida = null; // Limpa o buffer de memória após o consumo
});

// Retorna todos os alunos cadastrados no sistema
app.get("/alunos", async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM alunos`);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ erro: error.message });
    }
});

// Retorna o relatório em tempo real do diário de chamada
app.get("/presencas", async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM presencas ORDER BY id DESC`);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ erro: error.message });
    }
});

app.listen(3000, '0.0.0.0', () => {
    console.log("[SYSTEM] Servidor rodando na porta 3000 e aceitando conexões na rede.");
});