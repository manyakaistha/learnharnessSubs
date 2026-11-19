"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ANTIGRAVITY_REQUEST_HEADER, type AntigravityAction, type AntigravityStatus, type UserSettings } from "@/src/core";
import { notifySettingsSaved } from "@/components/settings-signal";
import { Button } from "@/components/ui/button";
import { Toggle } from "./controls";

const API = "/api/antigravity";
const INTENT = { [ANTIGRAVITY_REQUEST_HEADER]: "1" };
const BUTTON_CLASS = "cursor-pointer disabled:cursor-not-allowed";

/** Never trust a response body's shape before rendering it. */
function isStatus(value: unknown): value is AntigravityStatus {
	const status = value as Partial<AntigravityStatus> | null;
	return !!status && typeof status === "object" && typeof status.enabled === "boolean"
		&& !!status.runtime && typeof status.runtime === "object" && typeof status.runtime.state === "string"
		&& !!status.account && typeof status.account === "object" && typeof status.account.state === "string"
		&& Array.isArray(status.models);
}

function backgroundAction(status: AntigravityStatus | null): boolean {
	return status?.runtime.state === "installing" || status?.account.state === "signing-in";
}

export function AntigravityInstallationStatus() {
	const [status, setStatus] = useState<AntigravityStatus | null>(null);
	const [saving, setSaving] = useState(false);
	const [acting, setActing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const request = useRef<AbortController | null>(null);
	const lastStatus = useRef<AntigravityStatus | null>(null);

	const startRequest = useCallback(() => {
		request.current?.abort();
		const controller = new AbortController();
		request.current = controller;
		return controller;
	}, []);

	const acceptStatus = useCallback((next: AntigravityStatus, refreshed = false) => {
		const last = lastStatus.current;
		lastStatus.current = next;
		setStatus(next);
		if (last && (refreshed
			|| last.runtime.version !== next.runtime.version
			|| last.modelsUpdatedAt !== next.modelsUpdatedAt
			|| (last.account.state === "signing-in" && next.account.state === "signed-in"))) {
			notifySettingsSaved("antigravity");
		}
	}, []);

	const read = useCallback(async (clearError = true) => {
		const controller = startRequest();
		try {
			const response = await fetch(API, { cache: "no-store", signal: controller.signal, headers: INTENT });
			if (!response.ok) throw new Error("status unavailable");
			const next: unknown = await response.json();
			if (!isStatus(next)) throw new Error("invalid status");
			if (!controller.signal.aborted) {
				acceptStatus(next);
				if (clearError) setError(null);
			}
		} catch {
			if (!controller.signal.aborted && clearError) setError("Could not load Antigravity status.");
		}
	}, [acceptStatus, startRequest]);

	useEffect(() => {
		void read();
		return () => request.current?.abort();
	}, [read]);

	const enabled = status?.enabled === true;
	const processing = backgroundAction(status);
	useEffect(() => {
		if (!enabled || !processing || saving || acting) return;
		let stopped = false;
		let timer: ReturnType<typeof setTimeout>;
		const poll = async () => {
			await read();
			if (!stopped) timer = setTimeout(poll, 1_000);
		};
		timer = setTimeout(poll, 1_000);
		return () => {
			stopped = true;
			clearTimeout(timer);
		};
	}, [enabled, processing, saving, acting, read]);

	const save = async (next: boolean) => {
		if (!status) return;
		const controller = startRequest();
		setSaving(true);
		setError(null);
		let recheck = false;
		try {
			const response = await fetch("/api/settings/antigravity", {
				method: "PUT", headers: { "Content-Type": "application/json" }, signal: controller.signal,
				body: JSON.stringify({ enabled: next }),
			});
			if (!response.ok) throw new Error("settings write failed");
			const { settings } = await response.json() as { settings: UserSettings };
			const saved = settings?.antigravity?.enabled;
			if (typeof saved !== "boolean") throw new Error("invalid settings response");
			if (!controller.signal.aborted) {
				acceptStatus({ ...status, enabled: saved });
				notifySettingsSaved("antigravity");
				recheck = saved;
			}
		} catch {
			if (!controller.signal.aborted) setError("Could not save Antigravity settings.");
		} finally {
			if (!controller.signal.aborted) {
				setSaving(false);
				if (recheck) void read();
			}
		}
	};

	const run = async (action: AntigravityAction) => {
		const controller = startRequest();
		setActing(true);
		setError(null);
		let recheck = false;
		try {
			const response = await fetch(API, {
				method: "POST", headers: { ...INTENT, "Content-Type": "application/json" }, signal: controller.signal,
				body: JSON.stringify({ action }),
			});
			const body = await response.json() as AntigravityStatus | { error: string };
			if (controller.signal.aborted) return;
			if (response.ok && isStatus(body)) acceptStatus(body, action === "refresh");
			else {
				const message = (body as { error?: unknown } | null)?.error;
				setError(typeof message === "string" ? message : "Could not change Antigravity. Try again.");
				recheck = true;
			}
		} catch {
			if (!controller.signal.aborted) {
				setError("Could not change Antigravity. Try again.");
				recheck = true;
			}
		} finally {
			if (!controller.signal.aborted) {
				setActing(false);
				if (recheck) void read(false);
			}
		}
	};

	const busy = saving || acting || processing;
	const runtime = status?.runtime;
	const version = runtime?.version;
	const updateAvailable = runtime?.updateAvailable === true;
	const account = status?.account;
	const runtimeLabel = runtime?.state === "installing"
		? ["Installing…", runtime.progress].filter(Boolean).join(" ")
		: !status?.platformSupported ? "Unavailable on this platform"
		: version ? `Version ${version}${updateAvailable ? " · update available" : ""}` : "Not installed";
	const accountLabel = account?.state === "signing-in" ? "Signing in…"
		: account?.state === "signed-in" ? `Signed in${account.tier ? ` · ${account.tier}` : ""}`
		: "Not signed in";
	const actionButton = (action: AntigravityAction, label: string, disabled = busy) =>
		<Button type="button" size="xs" variant="outline" className={BUTTON_CLASS} disabled={disabled}
			onClick={() => void run(action)} data-testid={`antigravity-${action}`}>{label}</Button>;

	return <div className="space-y-2" data-testid="antigravity-installation">
		<div className="flex items-center gap-3">
			<span className="font-prose text-(length:--lh-prose-size) text-foreground">Antigravity</span>
			<Toggle label="Antigravity" checked={enabled} disabled={!status || saving || acting} onChange={(next) => void save(next)} />
		</div>
		{error && <p role="alert" className="text-xs text-error">{error}</p>}
		{enabled && status && <>
			<div className="flex flex-wrap items-center gap-3">
				<span role="status" className="text-xs text-muted-foreground" data-testid="antigravity-runtime-status">{runtimeLabel}</span>
				{status.platformSupported && !version && actionButton("install", "Install")}
				{updateAvailable && actionButton("update", "Update")}
				{version && actionButton("remove", "Remove downloaded runtime")}
			</div>
			{runtime?.error && error !== runtime.error && <p role="alert" className="text-xs text-error">{runtime.error}</p>}
			<div className="flex flex-wrap items-center gap-3">
				<span role="status" className="text-xs text-muted-foreground" data-testid="antigravity-account-status">{accountLabel}</span>
				{actionButton("sign-in", "Sign in", busy || !version)}
				{account?.authorizationUrl && <a href={account.authorizationUrl} target="_blank" rel="noreferrer"
					className="text-xs underline underline-offset-2 hover:text-foreground" data-testid="antigravity-sign-in-link">Open sign-in link ↗</a>}
			</div>
			{account?.error && error !== account.error && <p role="alert" className="text-xs text-error">{account.error}</p>}
			<div className="flex flex-wrap items-center gap-3">
				<span role="status" className="text-xs text-muted-foreground" data-testid="antigravity-models-status">
					{status.models.length} {status.models.length === 1 ? "model" : "models"}
				</span>
				{actionButton("refresh", "Refresh models", busy || !version)}
			</div>
			<p className="text-xs leading-relaxed text-muted-foreground">LearnHarness downloads Google’s Antigravity CLI (about 220 MB) and uses a private profile. Your Antigravity plan’s limits apply.</p>
			<p className="text-xs leading-relaxed text-muted-foreground">The Google login can be shared with other agy installations on this computer. To sign out, use agy itself.</p>
			<p className="text-xs leading-relaxed text-muted-foreground">Verify AI claims independently—they may be inaccurate, incomplete, misleading, or outdated.</p>
		</>}
	</div>;
}
