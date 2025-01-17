import { expect } from "chai";
require("mocha").describe;
require("mocha").it;
import { TernarySearchTree } from "../../../src/system";

describe("searchTree.ts", () => {
	describe("TernarySearchTree", () => {
		it("can set and remove a path", () => {
			const tree = TernarySearchTree.forPaths();
			tree.set("c:/foo/bar/baz", "bar");
			tree.set("c:/foo/bar", "bar");
			expect(Array.from(tree.values()).length).to.equal(2);

			const f = tree.findSuperstr("c:/foo");
			for (const [, k] of f!.entries()) {
				tree.delete(k);
			}
			expect(Array.from(tree.values()).length).to.equal(0);
		});
	});
});
