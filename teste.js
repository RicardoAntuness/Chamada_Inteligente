const pool = require("./db");

async function test() {
    try {
        const result = await pool.query("SELECT current_database(), current_user");
        console.log(result.rows);
    } catch (err) {
        console.error(err);
    } finally {
        process.exit();
    }
}

test();