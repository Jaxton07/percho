import { execFile } from "node:child_process";

export function getGitBranch(cwd: string): Promise<string | null> {
	return new Promise((resolve) => {
		execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: 3000 }, (error, stdout) => {
			if (error) resolve(null);
			else resolve(stdout.trim() || null);
		});
	});
}

export function listGitBranches(cwd: string): Promise<{ current: string | null; branches: string[] }> {
	return new Promise((resolve) => {
		execFile(
			"git",
			["for-each-ref", "--format=%(refname:short)", "refs/heads/"],
			{ cwd, timeout: 5000 },
			async (error, stdout) => {
				if (error) {
					resolve({ current: null, branches: [] });
					return;
				}
				const branches = stdout
					.split("\n")
					.map((b) => b.trim())
					.filter(Boolean);
				resolve({ current: await getGitBranch(cwd), branches });
			},
		);
	});
}

export function checkoutBranch(cwd: string, branch: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("git", ["checkout", branch], { cwd, timeout: 15000 }, async (error, _stdout, stderr) => {
			if (error) {
				reject(new Error(stderr?.trim() || error.message));
				return;
			}
			resolve((await getGitBranch(cwd)) ?? branch);
		});
	});
}
