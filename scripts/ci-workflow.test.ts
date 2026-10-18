import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
const workflow = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
const requiredRuntimeJobs = ["vitest", "behavior-evals", "packaged-server", "ui-smoke", "browser-identity", "browser-driver"];
function runGate(needs: Record<string, unknown>) {
    // Execute the actual gate, not a duplicate of its success/failure logic.
    const command = workflow.jobs.gate.steps[0].run as string;
    const script = command.match(/node --input-type=module -e '([\s\S]+)'/);
    expect(script).not.toBeNull();
    const check = spawnSync(process.execPath, ["--input-type=module", "-e", script![1]], {
        env: { ...process.env, NEEDS: JSON.stringify(needs) },
        encoding: "utf8",
        timeout: 5000,
    });
    expect(check.error).toBeUndefined();
    return check;
}
function gateNeeds(runtime: string) {
    return {
        static: { result: "success", outputs: { runtime } },
        ...Object.fromEntries(requiredRuntimeJobs.map((job) => [job, { result: runtime === "true" ? "success" : "skipped" }])),
    };
}
describe("CI concurrency", () => {
    it("runs read-only Linux checks without publication or containers", () => {
        for (const name of readdirSync(new URL("../.github/workflows/", import.meta.url))) {
            const source = readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");
            const configured = parse(source);
            expect(configured.permissions, name).not.toHaveProperty("packages", "write");
            expect(configured.permissions, name).not.toHaveProperty("contents", "write");
            expect(source, name).not.toMatch(/docker (?:build|run|compose|push)|npm publish|gh release|docker\/(?:login|build-push)-action/);
        }
        for (const job of Object.values(workflow.jobs) as { "runs-on": string; strategy?: { matrix: { os?: string[] | string } } }[]) {
            if (job["runs-on"] === "${{ matrix.os }}") {
                expect(job.strategy?.matrix.os).toSatisfy((os: string[] | string) => os === "${{ fromJSON(needs.static.outputs.vitest_os) }}" || JSON.stringify(os) === '["ubuntu-latest"]');
            } else {
                expect(job["runs-on"]).toMatch(/^ubuntu-/);
            }
        }
    });

    it("executes offline scenarios and golden replay only in the eval suite", () => {
        const runs = workflow.jobs["behavior-evals"].steps.map((step: { run?: string }) => step.run ?? "").join("\n");
        expect(runs).toContain("--config evals/vitest.config.ts");
        expect(runs).not.toMatch(/pnpm eval(?:\n| --golden)/);
        expect(workflow.jobs["behavior-evals"].env.QUATI_EVAL_LIVE).toBe("0");
        const rootConfig = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
        expect(rootConfig).not.toContain('"evals/**/*.test.ts"');
    });

    it("runs only for pull requests and supersedes their older checks", () => {
        expect(workflow.on).toEqual({ pull_request: null });
        expect(workflow.concurrency).toEqual({ group: "ci-pr-${{ github.event.pull_request.number }}", "cancel-in-progress": true });
    });
    it("stops a closed PR's run by joining ci.yml's PR group", () => {
        const stop = parse(readFileSync(new URL("../.github/workflows/ci-stop-closed.yml", import.meta.url), "utf8"));
        expect(stop.on).toEqual({ pull_request: { types: ["closed"] } });
        expect(stop.concurrency).toEqual({ group: "ci-pr-${{ github.event.pull_request.number }}", "cancel-in-progress": true });
        expect(workflow.concurrency.group).toBe(stop.concurrency.group);
    });
    it("never lets a merged PR's stop run join main's group", () => {
        // A merged PR's closed event reports the base branch as github.ref, so a
        // ref-named group would cancel main's CI on every merge.
        const stop = parse(readFileSync(new URL("../.github/workflows/ci-stop-closed.yml", import.meta.url), "utf8"));
        expect(stop.concurrency.group).not.toContain("github.ref");
        expect(stop.concurrency.group).toContain("github.event.pull_request.number");
        expect(stop.permissions).toEqual({});
    });
    it("allows cancelled summary jobs to stop without skipping failure reporting", () => {
        expect(workflow.jobs.gate.if).toBe("${{ !cancelled() }}");
        expect(workflow.jobs.gate.needs).toEqual(["static", ...requiredRuntimeJobs]);
    });
    it("schedules one read-only final gate over the selected platform matrix", () => {
        expect(workflow.jobs.gate.name).toBe("CI");
        expect(workflow.jobs.gate.strategy).toBeUndefined();
        expect(workflow.permissions).toEqual({ contents: "read" });
        expect(workflow.jobs.vitest.strategy.matrix).toEqual({
            os: "${{ fromJSON(needs.static.outputs.vitest_os) }}", shard: [1, 2, 3, 4],
        });
        expect(workflow.jobs.vitest["timeout-minutes"]).toBe(30);
    });

    it("selects PR checks without access to Actions or credentials", () => {
        expect(workflow.jobs.static.permissions).toBeUndefined();
        const scope = workflow.jobs.static.steps.find((step: {
            id?: string;
        }) => step.id === "scope");
        expect(scope.env).toBeUndefined();
        expect(workflow.jobs.static.steps.some((step: { run?: string }) =>
            step.run === "pnpm exec tsc -b --force && pnpm exec tsc -p tsconfig.server.json")).toBe(true);
        for (const [name, job] of Object.entries(workflow.jobs) as [
            string,
            {
                permissions?: unknown;
            }
        ][]) {
            if (name !== "static")
                expect(job.permissions, name).toBeUndefined();
        }
    });
    it.each(requiredRuntimeJobs)("fails closed for every required %s outcome", (job) => {
        for (const result of ["success", "failure", "cancelled", "skipped"]) {
            const check = runGate({ ...gateNeeds("true"), [job]: { result } });
            expect(check.status, check.stderr).toBe(result === "success" ? 0 : 1);
        }
    });
    it("accepts only deliberately unselected jobs on docs-only PRs", () => {
        expect(runGate(gateNeeds("false")).status).toBe(0);
        for (const result of ["success", "failure", "cancelled"]) {
            expect(runGate({ ...gateNeeds("false"), vitest: { result } }).status).toBe(1);
        }
    });
    it("rejects failed preflight and missing or malformed selection", () => {
        for (const result of ["failure", "cancelled", "skipped"]) {
            expect(runGate({ ...gateNeeds("false"), static: { result, outputs: { runtime: "false" } } }).status).toBe(1);
        }
        for (const runtime of ["", "yes", "TRUE"])
            expect(runGate(gateNeeds(runtime)).status).toBe(1);
        expect(runGate({ ...gateNeeds("false"), static: { result: "success", outputs: {} } }).status).toBe(1);
    });
    it("always starts the workflow and validates selection and docs before fanout", () => {
        expect(workflow.on.pull_request).toBeNull();
        expect(workflow.jobs.static.if).toBeUndefined();
        expect(workflow.jobs.static.steps[0].with["fetch-depth"]).toBe(0);
        expect(workflow.jobs.static.steps.find((step: {
            id?: string;
        }) => step.id === "scope").run).toBe("node scripts/ci-scope.mjs");
        expect(workflow.jobs.static.outputs).toEqual({
            runtime: "${{ steps.scope.outputs.runtime }}",
            vitest_os: "${{ steps.scope.outputs.vitest_os }}",
        });
        expect(workflow.jobs.static.steps.some((step: {
            run?: string;
        }) => step.run === "pnpm exec vitest run scripts/ci-scope.test.ts scripts/ci-workflow.test.ts scripts/testing/verification-docs.test.ts")).toBe(true);
        for (const [name, job] of Object.entries(workflow.jobs) as [
            string,
            {
                needs?: string | string[];
                if?: string;
            }
        ][]) {
            if (["static", "gate"].includes(name))
                continue;
            expect(job.needs).toBe("static");
            expect(job.if).toBe("needs.static.outputs.runtime == 'true'");
        }
    });

    it("builds the web UI before exercising the bundled server", () => {
        const runs = workflow.jobs["packaged-server"].steps.map((step: { run?: string }) => step.run).filter(Boolean);
        expect(runs.indexOf("pnpm build")).toBeGreaterThanOrEqual(0);
        expect(runs.indexOf("pnpm build")).toBeLessThan(runs.indexOf("pnpm test:packaged-server"));
    });

});
