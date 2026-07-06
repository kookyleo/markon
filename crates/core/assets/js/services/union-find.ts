/**
 * Union-Find data structure - pure technical, no business logic
 */

export class UnionFind {
    #parent: number[];
    #rank: number[];

    constructor(size: number) {
        this.#parent = Array.from({ length: size }, (_, i) => i);
        this.#rank = Array<number>(size).fill(0);
    }

    #valueAt(values: number[], index: number): number {
        const value = values[index];
        if (value === undefined) throw new RangeError(`UnionFind index ${index} is outside bounds`);
        return value;
    }

    find(x: number): number {
        const parent = this.#valueAt(this.#parent, x);
        if (parent !== x) {
            this.#parent[x] = this.find(parent);
        }
        return this.#valueAt(this.#parent, x);
    }

    union(x: number, y: number): void {
        const rootX = this.find(x);
        const rootY = this.find(y);
        if (rootX === rootY) return;

        const rankX = this.#valueAt(this.#rank, rootX);
        const rankY = this.#valueAt(this.#rank, rootY);
        if (rankX < rankY) {
            this.#parent[rootX] = rootY;
        } else if (rankX > rankY) {
            this.#parent[rootY] = rootX;
        } else {
            this.#parent[rootY] = rootX;
            this.#rank[rootX] = rankX + 1;
        }
    }
}
