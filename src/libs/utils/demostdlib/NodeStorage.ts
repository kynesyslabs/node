export class NodeStorage {
    private static instance: NodeStorage;
    private storage: Map<string, any> = new Map<string, any>();

    constructor() {}

    public static getInstance(): NodeStorage {
        if (!NodeStorage.instance) {
            NodeStorage.instance = new NodeStorage();
        }
        return NodeStorage.instance;
    }

    public getItem(key: string): string | null {
        if (this.storage.has(key)) {
            return this.storage.get(key);
        } else {
            return null;
        }
    }

    public setItem(key: string, value: string): void {
        this.storage.set(key, value);
    }

}