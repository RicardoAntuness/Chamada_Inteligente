// ===============================
// SERIAL ARDUINO
// ===============================

const portaArduino = new SerialPort({
    path: "/dev/ttyACM0",
    baudRate: 9600
});

let bufferSerial = "";

portaArduino.on("open", () => {
    console.log("Arduino conectado.");
    console.log("Porta:", portaArduino.path);
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

portaArduino.on("data", async (data) => {

    const textoRecebido = data.toString();

    console.log("RAW:", JSON.stringify(textoRecebido));

    bufferSerial += textoRecebido;

    const linhas = bufferSerial.split("\n");

    bufferSerial = linhas.pop();

    for (const linha of linhas) {

        const texto = linha.trim();

        console.log("LINHA:", texto);

        if (!texto.startsWith("{")) {
            console.log("IGNORADO:", texto);
            continue;
        }

        try {

            const dados = JSON.parse(texto);

            console.log("JSON OK:", dados);

            if (dados.uid) {

                const uid = dados.uid.replace(/\s+/g, "");
                const distancia = dados.distancia;

                console.log("UID:", uid);
                console.log("DISTÂNCIA:", distancia);

                ultimaTagLida = { uid };

                // Aluno se afastou
                if (distancia > 30) {

                    if (ocupandoSensor[uid]) {
                        console.log(`[SAÍDA] Aluno ${uid} se afastou.`);
                        delete ocupandoSensor[uid];
                    }

                    continue;
                }

                // Aluno aproximou
                if (distancia > 0 && distancia < 10) {

                    if (ocupandoSensor[uid]) {
                        console.log("Tag já processada.");
                        continue;
                    }

                    const alunoCheck = await pool.query(
                        `SELECT id, nome FROM alunos WHERE uid = $1`,
                        [uid]
                    );

                    if (alunoCheck.rows.length === 0) {

                        console.log("Aluno não encontrado:", uid);

                        enviarComando("NEGADO");
                        continue;
                    }

                    ocupandoSensor[uid] = true;

                    console.log(
                        `[VALIDADO] ${alunoCheck.rows[0].nome}. Registrando presença...`
                    );

                    await registrarPresencaMecanismo(uid);
                }
            }

        } catch (erro) {

            console.error("Erro ao interpretar JSON:");
            console.error(texto);
            console.error(erro.message);
        }
    }
});

// ==========================================
// TESTE PELO TERMINAL
// ==========================================

process.stdin.on("data", (data) => {

    const input = data.toString().trim();

    portaArduino.emit(
        "data",
        Buffer.from(input + "\n")
    );
});