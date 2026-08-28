import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
const emptyDatabase = () => ({
    version: 1,
    agents: [],
    messages: [],
    runs: [],
});
export class JsonStore {
    filePath;
    data = emptyDatabase();
    queue = Promise.resolve();
    constructor(filePath) {
        this.filePath = filePath;
    }
    async initialize() {
        await mkdir(path.dirname(this.filePath), { recursive: true });
        try {
            const raw = await readFile(this.filePath, "utf8");
            const parsed = JSON.parse(raw);
            if (parsed.version !== 1 || !Array.isArray(parsed.agents)) {
                throw new Error("Unsupported database format");
            }
            this.data = parsed;
        }
        catch (error) {
            if (error.code !== "ENOENT") {
                throw error;
            }
            await this.persist();
        }
    }
    snapshot() {
        return structuredClone(this.data);
    }
    async mutate(mutation) {
        let result;
        const operation = this.queue.then(async () => {
            const next = structuredClone(this.data);
            result = await mutation(next);
            await this.persist(next);
            this.data = next;
        });
        this.queue = operation.catch(() => undefined);
        await operation;
        return result;
    }
    async persist(data = this.data) {
        const temporaryPath = this.filePath + ".tmp";
        await writeFile(temporaryPath, JSON.stringify(data, null, 2) + "\n", {
            encoding: "utf8",
            mode: 0o600,
        });
        await rename(temporaryPath, this.filePath);
    }
}
