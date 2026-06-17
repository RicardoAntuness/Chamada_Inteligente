const { Pool } = require("pg");

const pool = new Pool({
    user: "admin",
    password: "admin", // <--- Mude de "1234" para "admin"
    host: "localhost",
    port: 5432,
    database: "chamada"
});

module.exports = pool;