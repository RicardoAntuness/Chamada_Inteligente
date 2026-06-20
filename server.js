const express = require("express");
const cors = require("cors");
const pool = require("./db");
const { SerialPort } = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");

const app = express();

app.use(cors({
    origin: "*", 
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
}));
// =======================================================
// VARIÁVEIS DE CONTROLE DE ESTADO GLOBAL
// =======================================================
let inicioAula = null; 
let ultimaTagLida = null;
let modoCadastroAtivo = false; // Controla se o sensor está lendo para presença ou para cadastro

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
// Filtra e valida a aproximação física da tag no sensor ultrassônico
async function processarLeitura(uidBruto, distancia) {
    const uid = String(uidBruto).trim().toUpperCase(); 

    if (modoCadastroAtivo) {
        ultimaTagLida = { uid };
        console.log(`[CADASTRO] Tag ${uid} na memória.`);
        enviarComando("APROVADO"); 
        return; 
    }

    // AQUI ESTÁ O SEGREDO: Só libera o aluno para bater a tag de novo 
    // quando ele afastar o cartão fisicamente para mais de 30cm.
    if (distancia > 30) {
        if (ocupandoSensor[uid]) {
            console.log(`[SENSOR] Cartão ${uid} retirado. Sistema pronto para nova leitura.`);
            delete ocupandoSensor[uid]; 
        }
        return;
    }

    if (distancia >= 0 && distancia <= 20) {
        
        // Se a trava está ativa, ignora as dezenas de leituras por segundo do Arduino
        if (ocupandoSensor[uid]) {
            return; 
        }

        // 1. Coloca a trava ANTES de ir pro banco
        ocupandoSensor[uid] = true;

        const alunoCheck = await pool.query(`SELECT id, nome FROM alunos WHERE UPPER(uid) = UPPER($1)`, [uid]);

        if (alunoCheck.rows.length === 0) {
            enviarComando("NEGADO");
            console.log(`[AUDITORIA] Acesso Negado: Tag '${uid}' sem cadastro.`);
            delete ocupandoSensor[uid]; // Tira a trava se deu erro, pro usuário tentar de novo
            return;
        }

        console.log(`[AUDITORIA] Tag reconhecida -> Aluno: ${alunoCheck.rows[0].nome}`);
        
        // 2. Chama a função de banco de dados (que agora NÃO DELETA a trava)
        await registrarPresencaMecanismo(uid);
    }
}

// Calcula matematicamente os blocos de falta
async function registrarPresencaMecanismo(uid) {
    if (!inicioAula) {
        console.log(`[AUDITORIA] Registro Rejeitado: Aula não iniciada.`);
        enviarComando("NEGADO");
        delete ocupandoSensor[uid]; // Aula não começou, libera o sensor
        return;
    }

    try {
        const registroExistente = await pool.query(
            "SELECT * FROM presencas WHERE uid = $1 ORDER BY id DESC LIMIT 1",
            [uid]
        );

        if (registroExistente.rows.length > 0) {
            const registroAtual = registroExistente.rows[0];

            // ALUNO VOLTANDO PRA SALA
            if (registroAtual.status === "SAIU") {
                const segundos = Math.floor((Date.now() - inicioAula) / 1000);
                const faltas = Math.min(Math.floor(segundos / 25), 4);
                const status = faltas === 0 ? "PRESENTE" : "ATRASADO";

                await pool.query(
                    "UPDATE presencas SET status = $1, faltas = $2 WHERE id = $3",
                    [status, faltas, registroAtual.id]
                );
                console.log(`[AUDITORIA] RE-ENTRADA: Aluno ${uid} | Status: ${status}`);
                enviarComando("APROVADO");
                // Trava mantida. Só sai quando ele afastar o braço.
                return;
            }

            // ALUNO SAINDO DA SALA (Passando a tag pela segunda vez)
            const segundosPresente = Math.floor((Date.now() - inicioAula) / 1000);
            let faltasPeloAbandono = 0;

            if (segundosPresente < 25) faltasPeloAbandono = 4;
            else if (segundosPresente < 50) faltasPeloAbandono = 3;
            else if (segundosPresente < 75) faltasPeloAbandono = 2;
            else if (segundosPresente < 100) faltasPeloAbandono = 1;

            let faltasTotaisAtualizadas = Math.min(registroAtual.faltas + faltasPeloAbandono, 4);

            await pool.query(
                "UPDATE presencas SET status = $1, faltas = $2 WHERE id = $3",
                ["SAIU", faltasTotaisAtualizadas, registroAtual.id]
            );

            console.log(`[AUDITORIA] SAÍDA: Aluno ${uid} abandonou a sala. Status atualizado para SAIU. Total Faltas: ${faltasTotaisAtualizadas}`);
            enviarComando("APROVADO"); 
            // Trava mantida. Só sai quando ele afastar o braço.
            return;
        }

        // PRIMEIRA ENTRADA DO ALUNO NO DIA
        const segundos = Math.floor((Date.now() - inicioAula) / 1000);
        const faltas = Math.min(Math.floor(segundos / 25), 4);
        const status = faltas === 0 ? "PRESENTE" : "ATRASADO";

        await pool.query(
            `INSERT INTO presencas (uid, status, faltas, data_registro) VALUES ($1, $2, $3, NOW())`,
            [uid, status, faltas]
        );

        console.log(`[AUDITORIA] ENTRADA: Aluno ${uid} registrou primeira entrada. Status: ${status}`);
        enviarComando("APROVADO");
        // Trava mantida. Só sai quando ele afastar o braço.

    } catch (error) {
        console.error("[DATABASE] Erro crítico no mecanismo de presença/saída:", error.message);
        enviarComando("NEGADO");
        delete ocupandoSensor[uid]; // Se der erro de SQL, destrava para tentar de novo
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
    modoCadastroAtivo = true; // Ativa o modo interceptador
    ultimaTagLida = null;     // Limpa o cache antigo
    console.log("[API] Comando recebido: MODO_CADASTRO acionado.");
    enviarComando("MODO_CADASTRO");
    return res.status(200).json({ mensagem: "Comando de modo cadastro enviado!" });
});

// Cancela o modo cadastro no hardware caso ocorra timeout no frontend
app.post("/cadastro/cancelar", (req, res) => {
    modoCadastroAtivo = false; // Desativa o modo interceptador
    ultimaTagLida = null;      // Limpa a memória
    console.log("[API] Tempo limite esgotado ou cancelado. Cancelando MODO_CADASTRO.");
    enviarComando("NEGADO");   // Feedback visual no arduino de cancelamento
    return res.status(200).json({ mensagem: "Modo cadastro cancelado com sucesso." });
});

// Salva de forma persistente os dados de um novo aluno no banco de dados
app.post("/cadastro/salvar", async (req, res) => {
    try {
        const { uid, nome } = req.body;
        await pool.query(`INSERT INTO alunos (uid, nome) VALUES ($1, $2)`, [uid, nome]);
        enviarComando("CADASTRO_OK");
        
        modoCadastroAtivo = false; // Finalizou o cadastro, volta ao normal
        ultimaTagLida = null;      // Limpa para a próxima vez
        
        console.log(`[DATABASE] Novo aluno registrado -> Nome: ${nome} | Tag: ${uid}`);
        res.json({ sucesso: true, message: "Aluno cadastrado!" });
    } catch (error) {
        enviarComando("NEGADO");
        modoCadastroAtivo = false; // Trava de segurança: volta ao normal mesmo em erro
        console.error("[DATABASE] Falha ao cadastrar aluno:", error.message);
        res.status(500).json({ erro: "Falha ao cadastrar." });
    }
});

// Polling do Frontend: Consulta a memória em busca da última tag lida para popular os inputs
app.get("/cadastro/status", (req, res) => {
    res.json(ultimaTagLida || { uid: null });
    
    // Deixamos a tag disponível no cache até o front-end chamar /salvar ou /cancelar.
    // Assim o usuário não perde a leitura se o frontend pedir duas vezes acidentalmente.
});

// Retorna todos os alunos cadastrados no sistema
app.get("/alunos", async (req, res) => {
    console.log(">>> ENTROU EM /alunos");

    try {
        console.log(">>> ANTES DO SELECT");

        const result = await pool.query("SELECT * FROM alunos");

        console.log(">>> DEPOIS DO SELECT");

        res.json(result.rows);
    } catch (error) {
        console.error(">>> ERRO:", error);

        res.status(500).json({
            erro: error.message
        });
    }
});

// Retorna o relatório em tempo real do diário de chamada
app.get("/presencas", async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                p.id,
                p.uid,
                a.nome,
                p.status,
                p.faltas,
                p.data_registro
            FROM presencas p
            LEFT JOIN alunos a
                ON a.uid = p.uid
            ORDER BY p.id DESC
        `);

        res.json(result.rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({
            erro: error.message
        });
    }
});

app.listen(3000, '0.0.0.0', () => {
    console.log("[SYSTEM] Servidor rodando na porta 3000 e aceitando conexões na rede.");
});