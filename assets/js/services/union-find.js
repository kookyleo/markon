/**
 * Union-Find data structure - pure technical, no business logic
 */

export class UnionFind {
    #parent;
    #rank;

    constructor(size) {
        this.#parent = Array.from({ length: size }, (_, i) => i);
        this.#rank = Array(size).fill(0);
    }

    find(x) {
        if (this.#parent[x] !== x) {
            this.#parent[x] = this.find(this.#parent[x]);
        }
        return this.#parent[x];
    }

    union(x, y) {
        const rootX = this.find(x);
        const rootY = this.find(y);
        if (rootX === rootY) return;

        if (this.#rank[rootX] < this.#rank[rootY]) {
            this.#parent[rootX] = rootY;
        } else if (this.#rank[rootX] > this.#rank[rootY]) {
            this.#parent[rootY] = rootX;
        } else {
            this.#parent[rootY] = rootX;
            this.#rank[rootX]++;
        }
    }
}
