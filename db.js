const { Pool } = require("pg");

const pool = new Pool({
    user: "admin",
    password: "1234",
    host: "postgres",
    port: 5432,
    database: "chamada"
});

module.exports = pool;