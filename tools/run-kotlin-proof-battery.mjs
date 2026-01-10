import { spawn } from "node:child_process";
import process from "node:process";
import path from "node:path";
import fs from "node:fs";

const repoRoot = process.cwd();
const kotlinRoot = path.join(repoRoot, "branches", "kotlin-consumer");

const isWindows = process.platform === "win32";
const cmd = isWindows ? "cmd.exe" : "./gradlew";
const args = isWindows ? ["/d", "/s", "/c", "gradlew.bat test"] : ["test"];

const env = { ...process.env };

if (!env.JAVA_HOME || env.JAVA_HOME.trim().length === 0) {
    const bootstrapRoot = path.join(kotlinRoot, ".gradle-bootstrap");
    if (fs.existsSync(bootstrapRoot)) {
        const entries = fs
            .readdirSync(bootstrapRoot, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name)
            .sort();

        for (const name of entries) {
            const candidateHome = path.join(bootstrapRoot, name);
            const javaBin = path.join(candidateHome, "bin");
            const javaExe = path.join(javaBin, isWindows ? "java.exe" : "java");
            if (fs.existsSync(javaExe)) {
                env.JAVA_HOME = candidateHome;
                env.PATH = `${javaBin}${path.delimiter}${env.PATH ?? ""}`;
                break;
            }
        }
    }
}

const child = spawn(cmd, args, { cwd: kotlinRoot, stdio: "inherit", env });
child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (err) => {
    // Surface spawn errors (missing Java/Gradle wrapper/etc).
    // eslint-disable-next-line no-console
    console.error(err?.stack || err?.message || String(err));
    process.exit(1);
});
