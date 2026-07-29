/*
 * MessageLoggerEnhanced
 * A standalone Vencord userplugin with persistent deleted-message and edit logs.
 *
 * Standalone: maintains its own persistent message cache and does not depend
 * on Vencord's built-in MessageLogger plugin.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelStore, FluxDispatcher, Menu, NavigationRouter, SelectedChannelStore, Toasts, UserStore } from "@webpack/common";

interface StoredAuthor {
    id: string;
    username: string;
    globalName?: string | null;
    avatar?: string | null;
    bot?: boolean;
}

interface StoredAttachment {
    id: string;
    filename: string;
    url?: string;
    proxyUrl?: string;
    contentType?: string;
}

interface PersistentLog {
    key: string;
    type: "deleted" | "edited";
    messageId: string;
    channelId: string;
    guildId?: string;
    author: StoredAuthor;
    content: string;
    oldContent?: string;
    newContent?: string;
    attachments: StoredAttachment[];
    messageTimestamp?: string;
    loggedAt: string;
}

interface CachedMessage {
    key: string;
    messageId: string;
    channelId: string;
    guildId?: string;
    author: StoredAuthor;
    content: string;
    attachments: StoredAttachment[];
    messageTimestamp?: string;
    lastSeenAt: string;
}

const STORE_KEY = "MessageLoggerEnhanced_logs_v1";
const CACHE_KEY = "MessageLoggerEnhanced_message_cache_v1";
const LEGACY_STORE_KEY = "PersistentMessageLogger_logs_v1";
const LEGACY_CACHE_KEY = "PersistentMessageLogger_message_cache_v1";
let logs: PersistentLog[] = [];
let messageCache: Record<string, CachedMessage> = {};
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let cacheSaveTimer: ReturnType<typeof setTimeout> | undefined;
let toolbarObserver: MutationObserver | undefined;
let toolbarButton: HTMLButtonElement | undefined;
let logDialog: HTMLDialogElement | undefined;
let dialogSearch = "";
let dialogSort: "newest" | "oldest" = "newest";
let dialogPage = 1;
const DIALOG_PAGE_SIZE = 20;
const retainedDeletedElements = new Map<string, HTMLElement>();

function normaliseAttachment(attachment: any): StoredAttachment {
    return {
        id: String(attachment?.id ?? ""),
        filename: String(attachment?.filename ?? "attachment"),
        url: attachment?.url,
        proxyUrl: attachment?.proxy_url ?? attachment?.proxyUrl,
        contentType: attachment?.content_type ?? attachment?.contentType
    };
}

function normaliseAuthor(author: any): StoredAuthor {
    return {
        id: String(author?.id ?? "unknown"),
        username: String(author?.username ?? "Unknown User"),
        globalName: author?.globalName ?? author?.global_name ?? null,
        avatar: author?.avatar ?? null,
        bot: Boolean(author?.bot)
    };
}

function cacheKey(channelId: string, messageId: string): string {
    return `${channelId}:${messageId}`;
}

function scheduleCacheSave() {
    if (cacheSaveTimer) clearTimeout(cacheSaveTimer);
    cacheSaveTimer = setTimeout(() => {
        cacheSaveTimer = undefined;
        void DataStore.set(CACHE_KEY, messageCache);
    }, 350);
}

function trimMessageCache() {
    const maximum = Math.max(1_000, Number(settings.store.maximumCachedMessages) || 50_000);
    const entries = Object.values(messageCache);
    if (entries.length <= maximum) return;

    entries.sort((a, b) => Date.parse(a.lastSeenAt) - Date.parse(b.lastSeenAt));
    const removeCount = entries.length - maximum;
    for (let index = 0; index < removeCount; index++)
        delete messageCache[entries[index].key];
}


function blockedGuildIds(): Set<string> {
    return new Set(
        String(settings.store.blockedServerIds ?? "")
            .split(/[\s,]+/)
            .map(id => id.trim())
            .filter(Boolean)
    );
}

function trackingMode(): "both" | "private" | "servers" {
    const configured = String((settings.store as any).trackingMode ?? "");
    if (configured === "private" || configured === "servers" || configured === "both")
        return configured;

    // Migration from the previous boolean setting.
    return (settings.store as any).privateMessagesOnly ? "private" : "both";
}

function setTrackingMode(mode: "both" | "private" | "servers") {
    (settings.store as any).trackingMode = mode;
    purgeUntrackedCache();

    for (const [key, element] of retainedDeletedElements) {
        const separator = key.indexOf(":");
        const channelId = separator === -1 ? key : key.slice(0, separator);
        if (!shouldTrackLocation(channelId)) {
            element.remove();
            retainedDeletedElements.delete(key);
        }
    }

    Toasts.show({
        message: mode === "private"
            ? "MessageLoggerEnhanced now tracks private messages only."
            : mode === "servers"
                ? "MessageLoggerEnhanced now tracks servers only."
                : "MessageLoggerEnhanced now tracks private messages and servers.",
        type: Toasts.Type.SUCCESS,
        id: Toasts.genId()
    });
}

function shouldTrackLocation(channelId: string, guildId?: string): boolean {
    const channel: any = ChannelStore.getChannel(channelId);
    const resolvedGuildId = guildId ?? channel?.guild_id;
    const isServer = Boolean(resolvedGuildId);
    const mode = trackingMode();

    if (mode === "private" && isServer)
        return false;
    if (mode === "servers" && !isServer)
        return false;

    if (isServer && blockedGuildIds().has(String(resolvedGuildId)))
        return false;

    return true;
}

function setGuildTracking(guildId: string, enabled: boolean) {
    const blocked = blockedGuildIds();

    if (enabled)
        blocked.delete(guildId);
    else
        blocked.add(guildId);

    settings.store.blockedServerIds = Array.from(blocked).join(",");
    purgeUntrackedCache();

    Toasts.show({
        message: enabled
            ? "MessageLoggerEnhanced is tracking this server again."
            : "MessageLoggerEnhanced stopped tracking this server.",
        type: Toasts.Type.SUCCESS,
        id: Toasts.genId()
    });
}

function purgeUntrackedCache() {
    let changed = false;

    for (const [key, message] of Object.entries(messageCache)) {
        if (!shouldTrackLocation(message.channelId, message.guildId)) {
            delete messageCache[key];
            changed = true;
        }
    }

    if (changed)
        scheduleCacheSave();
}

function makeCachedMessage(message: any, previous?: CachedMessage): CachedMessage | undefined {
    const channelId = String(message?.channel_id ?? message?.channelId ?? previous?.channelId ?? "");
    const messageId = String(message?.id ?? previous?.messageId ?? "");
    if (!channelId || !messageId) return undefined;

    const channel: any = ChannelStore.getChannel(channelId);
    const authorSource = message?.author ?? previous?.author;
    const author = authorSource && "username" in authorSource
        ? normaliseAuthor(authorSource)
        : previous?.author ?? normaliseAuthor(undefined);

    const attachmentsSource = message?.attachments;
    const attachments = attachmentsSource != null
        ? Array.from(attachmentsSource).map(normaliseAttachment)
        : previous?.attachments ?? [];

    const timestamp = message?.timestamp;
    return {
        key: cacheKey(channelId, messageId),
        messageId,
        channelId,
        guildId: channel?.guild_id ?? previous?.guildId,
        author,
        content: message?.content != null ? String(message.content) : previous?.content ?? "",
        attachments,
        messageTimestamp: timestamp?.toISOString?.() ?? (timestamp != null ? String(timestamp) : previous?.messageTimestamp),
        lastSeenAt: new Date().toISOString()
    };
}

function rememberMessage(message: any): CachedMessage | undefined {
    const channelId = String(message?.channel_id ?? message?.channelId ?? "");
    const messageId = String(message?.id ?? "");
    if (!channelId || !messageId) return undefined;

    const channel: any = ChannelStore.getChannel(channelId);
    if (!shouldTrackLocation(channelId, channel?.guild_id))
        return undefined;

    const key = cacheKey(channelId, messageId);
    const cached = makeCachedMessage(message, messageCache[key]);
    if (!cached) return undefined;

    messageCache[key] = cached;
    trimMessageCache();
    scheduleCacheSave();
    return cached;
}

function removeCachedMessage(channelId: string, messageId: string): CachedMessage | undefined {
    const key = cacheKey(channelId, messageId);
    const cached = messageCache[key];
    if (cached) {
        delete messageCache[key];
        scheduleCacheSave();
    }
    return cached;
}

function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        saveTimer = undefined;
        void DataStore.set(STORE_KEY, logs);
    }, 250);
}

function trimLogs() {
    const max = Math.max(100, Number(settings.store.maximumLogs) || 10000);
    if (logs.length > max)
        logs = logs.slice(logs.length - max);
}

function addLog(entry: PersistentLog) {
    const existingIndex = logs.findIndex(log => log.key === entry.key);
    if (existingIndex !== -1)
        logs[existingIndex] = entry;
    else
        logs.push(entry);

    trimLogs();
    scheduleSave();
    updateToolbarBadge();
    if (logDialog?.open) renderLogDialog();
}

function getChannelLogs(channelId: string) {
    return logs.filter(log => log.channelId === channelId);
}

function formatLog(log: PersistentLog): string {
    const displayName = log.author.globalName || log.author.username;
    const location = log.guildId
        ? `guild ${log.guildId}, channel ${log.channelId}`
        : `DM channel ${log.channelId}`;

    if (log.type === "edited") {
        return [
            `[EDITED] ${log.loggedAt}`,
            `${displayName} (${log.author.id})`,
            location,
            `Message ID: ${log.messageId}`,
            `Before: ${log.oldContent ?? ""}`,
            `After: ${log.newContent ?? ""}`,
            ""
        ].join("\n");
    }

    const attachmentText = log.attachments.length
        ? `\nAttachments:\n${log.attachments.map(a => `- ${a.filename}: ${a.url ?? a.proxyUrl ?? "URL unavailable"}`).join("\n")}`
        : "";

    return [
        `[DELETED] ${log.loggedAt}`,
        `${displayName} (${log.author.id})`,
        location,
        `Message ID: ${log.messageId}`,
        log.content || "(no text content)",
        attachmentText,
        ""
    ].join("\n");
}

function exportLogs(entries = logs) {
    const text = entries.length
        ? entries.map(formatLog).join("\n----------------------------------------\n\n")
        : "No saved message logs have been saved yet.";

    DiscordNative.clipboard.copy(text);
    Toasts.show({
        message: `Copied ${entries.length} saved log${entries.length === 1 ? "" : "s"} to clipboard.`,
        type: Toasts.Type.SUCCESS,
        id: Toasts.genId()
    });
}

function exportJson(entries = logs) {
    DiscordNative.clipboard.copy(JSON.stringify(entries, null, 2));
    Toasts.show({
        message: `Copied ${entries.length} log${entries.length === 1 ? "" : "s"} as JSON.`,
        type: Toasts.Type.SUCCESS,
        id: Toasts.genId()
    });
}


function escapeHtml(value: unknown): string {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function avatarUrl(author: StoredAuthor): string {
    if (author.avatar)
        return `https://cdn.discordapp.com/avatars/${author.id}/${author.avatar}.png?size=128`;

    let index = 0;
    try {
        index = Number(BigInt(author.id) >> 22n) % 6;
    } catch {
        index = 0;
    }
    return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

function channelLabel(channelId: string): string {
    const channel: any = ChannelStore.getChannel(channelId);
    return channel?.name ? `#${channel.name}` : `Channel ${channelId}`;
}

function relativeTime(iso: string): string {
    const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
    if (seconds < 60) return `${seconds || 1} second${seconds === 1 ? "" : "s"} ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
    return new Date(iso).toLocaleDateString();
}

function downloadJsonFile(entries: PersistentLog[]) {
    const deletedEntries = entries.filter(log => log.type === "deleted");
    const blob = new Blob([JSON.stringify(deletedEntries, null, 2)], {
        type: "application/json;charset=utf-8"
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");

    anchor.href = url;
    anchor.download = `MessageLoggerEnhanced-deleted-messages-${stamp}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);

    Toasts.show({
        message: `Downloaded ${deletedEntries.length} deleted-message log${deletedEntries.length === 1 ? "" : "s"}.`,
        type: Toasts.Type.SUCCESS,
        id: Toasts.genId()
    });
}

function removeLog(key: string) {
    const removed = logs.find(log => log.key === key);
    if (removed?.type === "deleted")
        removeRetainedMessage(removed.channelId, removed.messageId);

    logs = logs.filter(log => log.key !== key);
    scheduleSave();
    updateToolbarBadge();
    renderLogDialog();
}

function clearDeletedLogs() {
    for (const log of logs)
        if (log.type === "deleted")
            removeRetainedMessage(log.channelId, log.messageId);

    logs = logs.filter(log => log.type !== "deleted");
    scheduleSave();
    updateToolbarBadge();
    dialogPage = 1;
    renderLogDialog();
}

function getVisibleDeletedLogs() {
    const query = dialogSearch.trim().toLowerCase();
    const entries = logs.filter(log => log.type === "deleted").filter(log => {
        if (!query) return true;
        const channel = channelLabel(log.channelId);
        return [
            log.author.globalName,
            log.author.username,
            log.author.id,
            log.content,
            log.channelId,
            channel,
            log.messageId,
            ...log.attachments.map(attachment => attachment.filename)
        ].some(value => String(value ?? "").toLowerCase().includes(query));
    });

    return entries.sort((a, b) => {
        const difference = Date.parse(a.loggedAt) - Date.parse(b.loggedAt);
        return dialogSort === "oldest" ? difference : -difference;
    });
}


function jumpToLoggedMessage(log: PersistentLog) {
    const path = log.guildId
        ? `/channels/${log.guildId}/${log.channelId}`
        : `/channels/@me/${log.channelId}`;

    closeLogDialog();
    NavigationRouter.transitionTo(path);

    const cached: CachedMessage = {
        key: cacheKey(log.channelId, log.messageId),
        messageId: log.messageId,
        channelId: log.channelId,
        guildId: log.guildId,
        author: log.author,
        content: log.content,
        attachments: log.attachments,
        messageTimestamp: log.messageTimestamp,
        lastSeenAt: log.loggedAt
    };

    let attempts = 0;
    const tryJump = () => {
        attempts++;

        if (SelectedChannelStore.getChannelId() !== log.channelId) {
            if (attempts < 40)
                setTimeout(tryJump, 150);
            return;
        }

        let target = document.getElementById(retainedElementId(log.channelId, log.messageId));

        if (!target) {
            retainDeletedMessageInChat(cached);
            target = document.getElementById(retainedElementId(log.channelId, log.messageId));
        }

        if (target) {
            target.scrollIntoView({ behavior: "smooth", block: "center" });
            target.classList.remove("mle-jump-highlight");
            void target.offsetWidth;
            target.classList.add("mle-jump-highlight");
            setTimeout(() => target?.classList.remove("mle-jump-highlight"), 2400);
            return;
        }

        if (attempts < 40)
            setTimeout(tryJump, 150);
        else
            Toasts.show({
                message: "Opened the channel, but Discord had not loaded the message area yet.",
                type: Toasts.Type.MESSAGE,
                id: Toasts.genId()
            });
    };

    setTimeout(tryJump, 250);
}

function renderLogDialog() {
    if (!logDialog?.isConnected) return;

    const entries = getVisibleDeletedLogs();
    const totalPages = Math.max(1, Math.ceil(entries.length / DIALOG_PAGE_SIZE));
    dialogPage = Math.min(Math.max(1, dialogPage), totalPages);

    const startIndex = (dialogPage - 1) * DIALOG_PAGE_SIZE;
    const pageEntries = entries.slice(startIndex, startIndex + DIALOG_PAGE_SIZE);
    const firstShown = entries.length ? startIndex + 1 : 0;
    const lastShown = Math.min(startIndex + DIALOG_PAGE_SIZE, entries.length);

    const count = logDialog.querySelector<HTMLElement>(".mle-count");
    const list = logDialog.querySelector<HTMLElement>(".mle-list");
    const footerText = logDialog.querySelector<HTMLElement>(".mle-footer-text");
    const pageButton = logDialog.querySelector<HTMLButtonElement>(".mle-page-number");
    const previous = logDialog.querySelector<HTMLButtonElement>(".mle-previous");
    const next = logDialog.querySelector<HTMLButtonElement>(".mle-next");
    const download = logDialog.querySelector<HTMLButtonElement>(".mle-download");
    const clear = logDialog.querySelector<HTMLButtonElement>(".mle-clear");

    const allDeletedCount = logs.filter(log => log.type === "deleted").length;
    if (count)
        count.textContent = `${allDeletedCount} deleted message${allDeletedCount === 1 ? "" : "s"}`;
    if (footerText)
        footerText.textContent = `Displaying ${firstShown} – ${lastShown} of ${entries.length} deleted messages`;
    if (pageButton)
        pageButton.textContent = String(dialogPage);
    if (previous)
        previous.disabled = dialogPage <= 1;
    if (next)
        next.disabled = dialogPage >= totalPages;
    if (download)
        download.disabled = allDeletedCount === 0;
    if (clear)
        clear.disabled = allDeletedCount === 0;
    if (!list) return;

    if (!pageEntries.length) {
        list.innerHTML = `<div class="mle-empty">${dialogSearch ? "No deleted messages match your search." : "No deleted messages have been logged yet."}</div>`;
        return;
    }

    list.innerHTML = pageEntries.map(log => {
        const displayName = escapeHtml(log.author.globalName || log.author.username);
        const username = escapeHtml(log.author.username);
        const content = escapeHtml(log.content || "(no text content)");
        const channel = escapeHtml(channelLabel(log.channelId));
        const fullTime = escapeHtml(new Date(log.loggedAt).toLocaleString());
        const relative = escapeHtml(relativeTime(log.loggedAt));
        const avatar = escapeHtml(avatarUrl(log.author));

        const attachmentBlock = log.attachments.length
            ? `<div class="mle-attachments">${log.attachments.map(attachment => {
                const href = escapeHtml(attachment.url ?? attachment.proxyUrl ?? "");
                const filename = escapeHtml(attachment.filename);
                const isImage = String(attachment.contentType ?? "").startsWith("image/");
                return href
                    ? `<a class="mle-attachment" href="${href}" target="_blank" rel="noreferrer">
                        ${isImage ? `<img src="${href}" alt="">` : `<span class="mle-file-icon">▧</span>`}
                        <span>${filename}</span>
                    </a>`
                    : `<span class="mle-attachment"><span class="mle-file-icon">▧</span><span>${filename}</span></span>`;
            }).join("")}</div>`
            : "";

        return `<article class="mle-entry" data-jump-key="${escapeHtml(log.key)}" title="Click to open this message in chat">
            <img class="mle-avatar" src="${avatar}" alt="">
            <div class="mle-entry-body">
                <div class="mle-entry-header">
                    <div class="mle-author-line">
                        <strong>${displayName}</strong>
                        <span>@${username}</span>
                    </div>
                    <span class="mle-relative">${relative}</span>
                </div>
                <div class="mle-message">${content}</div>
                ${attachmentBlock}
                <div class="mle-meta-row">
                    <span class="mle-channel-pill">${channel}</span>
                    <span class="mle-deleted-pill">Deleted</span>
                </div>
                <div class="mle-id-line">
                    Channel: ${escapeHtml(log.channelId)}
                    <b>•</b>
                    Message ID: ${escapeHtml(log.messageId)}
                    <b>•</b>
                    Deleted: ${fullTime}
                </div>
            </div>
            <button class="mle-delete-one" data-delete-key="${escapeHtml(log.key)}" aria-label="Delete this log" title="Delete this log">
                <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M9 3V2h6v1h5v2H4V3h5Zm-3 4h12l-1 14H7L6 7Zm3 2 .5 10h1L10 9H9Zm4 0v10h1V9h-1Z"/></svg>
            </button>
        </article>`;
    }).join("");

    list.querySelectorAll<HTMLButtonElement>(".mle-delete-one").forEach(button => {
        button.addEventListener("click", event => {
            event.stopPropagation();
            const key = button.dataset.deleteKey;
            if (key) removeLog(key);
        });
    });

    list.querySelectorAll<HTMLElement>(".mle-entry[data-jump-key]").forEach(entry => {
        entry.addEventListener("click", event => {
            if ((event.target as HTMLElement).closest("a,button,input,select")) return;
            const key = entry.dataset.jumpKey;
            const log = logs.find(item => item.key === key);
            if (log) jumpToLoggedMessage(log);
        });
    });
}

function closeLogDialog() {
    const dialogs = new Set<HTMLDialogElement>();
    if (logDialog) dialogs.add(logDialog);
    document.querySelectorAll<HTMLDialogElement>("dialog.mle-dialog").forEach(dialog => dialogs.add(dialog));

    for (const dialog of dialogs) {
        try {
            if (dialog.open) dialog.close();
        } catch { }
        dialog.removeAttribute("open");
        dialog.remove();
    }

    logDialog = undefined;

    // Native <dialog> can occasionally leave focus/modal state behind in Discord.
    // Explicitly restore the app and focus the message box so the chat is usable immediately.
    const app = document.getElementById("app-mount");
    app?.removeAttribute("inert");
    app?.removeAttribute("aria-hidden");
    document.body.style.removeProperty("overflow");
    document.documentElement.style.removeProperty("overflow");

    requestAnimationFrame(() => {
        const input = document.querySelector<HTMLElement>('[role="textbox"][data-slate-editor="true"], [role="textbox"][contenteditable="true"]');
        input?.focus();
    });
}

function openLogDialog() {
    closeLogDialog();
    dialogSearch = "";
    dialogSort = "newest";
    dialogPage = 1;

    const dialog = document.createElement("dialog");
    dialog.className = "mle-dialog";
    dialog.innerHTML = `<style>
        .mle-dialog {
            width:min(1168px,calc(100vw - 48px));
            height:min(830px,calc(100vh - 48px));
            padding:0;
            border:1px solid var(--border-subtle,rgba(255,255,255,.10));
            border-radius:12px;
            overflow:hidden;
            color:var(--text-normal);
            background:var(--background-floating,#111214);
            box-shadow:0 22px 70px rgba(0,0,0,.62);
        }
        .mle-dialog::backdrop {
            background:rgba(0,0,0,.72);
            backdrop-filter:blur(3px);
        }
        .mle-shell {
            height:100%;
            display:flex;
            flex-direction:column;
            background:var(--background-floating,#111214);
        }
        .mle-header {
            min-height:116px;
            display:flex;
            align-items:center;
            justify-content:space-between;
            gap:24px;
            padding:24px 30px;
            border-bottom:1px solid var(--border-subtle,var(--background-modifier-accent));
            background:#17191e;
        }
        .mle-brand { display:flex; align-items:center; gap:18px; min-width:0; }
        .mle-brand-icon { width:44px; height:44px; color:#ffffff; flex:0 0 auto; filter:drop-shadow(0 1px 2px rgba(0,0,0,.5)); }
        .mle-title { margin:0; color:#ffffff !important; font-size:30px; line-height:1.1; font-weight:800; letter-spacing:-.35px; text-shadow:0 1px 3px rgba(0,0,0,.55); }
        .mle-subtitle { margin-top:7px; color:#e3e7ee !important; font-size:17px; font-weight:600; }
        .mle-count { margin-top:4px; color:#b9c1cf !important; font-size:15px; font-weight:600; }
        .mle-header-actions { display:flex; align-items:center; gap:14px; }
        .mle-action {
            height:48px;
            padding:0 19px;
            border:0;
            border-radius:8px;
            cursor:pointer;
            color:white;
            font-size:15px;
            font-weight:700;
            background:var(--brand-500,#5865f2);
        }
        .mle-action:hover:not(:disabled) { filter:brightness(1.08); }
        .mle-action:disabled { opacity:.45; cursor:not-allowed; }
        .mle-clear { background:var(--status-danger,#da373c); }
        .mle-close {
            width:42px;
            height:42px;
            border:0;
            border-radius:8px;
            cursor:pointer;
            color:#d7dce5 !important;
            background:transparent;
            font-size:32px;
            line-height:36px;
        }
        .mle-close:hover { color:var(--interactive-hover); background:var(--background-modifier-hover); }
        .mle-tracking-panel {
            display:flex;
            align-items:center;
            justify-content:space-between;
            gap:16px;
            padding:14px 30px;
            border-bottom:1px solid rgba(255,255,255,.10);
            background:#1d1f24;
        }
        .mle-tracking-copy { min-width:0; }
        .mle-tracking-title { color:#ffffff; font-size:15px; font-weight:700; }
        .mle-tracking-description { margin-top:3px; color:#b9c1cf; font-size:12px; }
        .mle-tracking-actions { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
        .mle-tracking-mode {
            min-width:230px;
            height:42px;
            padding:0 12px;
            border:1px solid rgba(255,255,255,.18);
            border-radius:7px;
            color:#ffffff;
            background:#2b2d31;
            font-size:14px;
            font-weight:650;
            cursor:pointer;
        }
        .mle-current-server-toggle {
            min-height:42px;
            padding:0 14px;
            border:1px solid rgba(255,255,255,.18);
            border-radius:7px;
            color:#ffffff;
            background:#35373c;
            font-size:13px;
            font-weight:700;
            cursor:pointer;
        }
        .mle-current-server-toggle[data-blocked="true"] { background:#3a2530; border-color:#da373c; }
        .mle-current-server-toggle:disabled { opacity:.45; cursor:not-allowed; }
        .mle-controls {
            display:flex;
            align-items:center;
            justify-content:space-between;
            gap:20px;
            padding:20px 30px;
            background:var(--background-floating,#111214);
        }
        .mle-search-wrap {
            width:min(550px,60%);
            height:50px;
            display:flex;
            align-items:center;
            gap:12px;
            padding:0 16px;
            border:1px solid rgba(255,255,255,.16);
            border-radius:7px;
            background:var(--input-background,var(--background-tertiary,#111214));
        }
        .mle-search {
            width:100%;
            border:0;
            outline:0;
            color:#f3f4f6 !important;
            background:transparent;
            font-size:16px;
        }
        .mle-search::placeholder { color:#b9c1cf !important; opacity:1; }
        .mle-search-icon { width:23px; height:23px; color:#d7dce5 !important; flex:0 0 auto; }
        .mle-sort {
            min-width:220px;
            height:50px;
            padding:0 16px;
            border:1px solid rgba(255,255,255,.16);
            border-radius:7px;
            color:#f3f4f6 !important;
            background:#2b2d31;
            font-size:15px;
            font-weight:600;
            cursor:pointer;
        }
        .mle-list {
            flex:1;
            min-height:0;
            overflow:auto;
            padding:0 30px 28px;
            background:var(--background-floating,#111214);
        }
        .mle-entry {
            position:relative;
            border-left:4px solid #f23f43 !important;
            cursor:pointer;
            transition:background .15s ease,border-color .15s ease,transform .15s ease;
            display:grid;
            grid-template-columns:56px minmax(0,1fr) 52px;
            gap:17px;
            padding:22px 22px;
            margin-bottom:14px;
            border:1px solid rgba(255,255,255,.16);
            border-radius:9px;
            background:#24262b;
        }
        .mle-avatar { width:56px; height:56px; border-radius:50%; object-fit:cover; }
        .mle-entry:hover {
            background:#2d3036;
            border-color:rgba(255,255,255,.28);
            transform:translateY(-1px);
        }
        .mle-entry-body { min-width:0; }
        .mle-entry-header { display:flex; align-items:center; justify-content:space-between; gap:16px; }
        .mle-author-line { display:flex; align-items:baseline; gap:10px; min-width:0; }
        .mle-author-line strong { color:#ffffff; font-size:17px; }
        .mle-author-line span,.mle-relative { color:var(--text-muted); font-size:14px; }
        .mle-message {
            margin-top:8px;
            color:#f2f3f5 !important;
            white-space:pre-wrap;
            overflow-wrap:anywhere;
            color:var(--text-normal);
            font-size:16px;
            line-height:1.45;
        }
        .mle-meta-row { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }
        .mle-channel-pill,.mle-deleted-pill {
            padding:5px 9px;
            border-radius:6px;
            color:var(--text-muted);
            background:var(--background-tertiary,#1e1f22);
            font-size:12px;
        }
        .mle-deleted-pill { border:1px solid rgba(218,55,60,.36); color:var(--status-danger-text,var(--status-danger,#da373c)); }
        .mle-id-line {
            display:flex;
            flex-wrap:wrap;
            gap:8px;
            margin-top:12px;
            color:var(--text-muted);
            font-size:12px;
        }
        .mle-id-line b { font-weight:400; opacity:.7; }
        .mle-attachments { display:flex; flex-wrap:wrap; gap:10px; margin-top:12px; }
        .mle-attachment {
            display:flex;
            align-items:center;
            gap:8px;
            max-width:300px;
            padding:7px 10px;
            border-radius:6px;
            color:var(--text-link);
            background:var(--background-tertiary,#1e1f22);
            text-decoration:none;
        }
        .mle-attachment img { width:34px; height:34px; border-radius:4px; object-fit:cover; }
        .mle-file-icon { font-size:20px; }
        .mle-delete-one {
            align-self:start;
            width:48px;
            height:48px;
            display:grid;
            place-items:center;
            border:1px solid var(--status-danger,#da373c);
            border-radius:7px;
            cursor:pointer;
            color:var(--status-danger,#da373c);
            background:transparent;
        }
        .mle-delete-one:hover { color:white; background:var(--status-danger,#da373c); }
        .mle-empty { height:100%; display:grid; place-items:center; color:var(--text-muted); font-size:16px; }
        .mle-footer {
            min-height:88px;
            display:flex;
            align-items:center;
            justify-content:space-between;
            gap:20px;
            padding:0 30px;
            border-top:1px solid var(--border-subtle,var(--background-modifier-accent));
            background:var(--background-floating,#111214);
        }
        .mle-footer-text { color:var(--text-muted); font-size:14px; }
        .mle-pagination { display:flex; align-items:center; gap:12px; }
        .mle-page-control {
            width:46px;
            height:46px;
            border:1px solid rgba(255,255,255,.16);
            border-radius:7px;
            cursor:pointer;
            color:var(--interactive-normal);
            background:#24262b;
            font-size:22px;
        }
        .mle-page-control:disabled { opacity:.35; cursor:not-allowed; }
        .mle-page-number { border-color:var(--brand-500,#5865f2); color:var(--header-primary); }
        @media(max-width:800px) {
            .mle-dialog { width:calc(100vw - 18px); height:calc(100vh - 18px); }
            .mle-header { align-items:flex-start; flex-direction:column; padding:20px; }
            .mle-header-actions { width:100%; flex-wrap:wrap; }
            .mle-tracking-panel { align-items:stretch; flex-direction:column; padding:14px 20px; }
            .mle-tracking-actions { align-items:stretch; flex-direction:column; }
            .mle-tracking-mode,.mle-current-server-toggle { width:100%; }
            .mle-controls { align-items:stretch; flex-direction:column; padding:16px 20px; }
            .mle-search-wrap { width:auto; }
            .mle-list { padding:0 20px 20px; }
            .mle-entry { grid-template-columns:44px minmax(0,1fr); }
            .mle-avatar { width:44px; height:44px; }
            .mle-delete-one { position:absolute; right:14px; top:14px; width:38px; height:38px; }
            .mle-relative { display:none; }
            .mle-footer { padding:14px 20px; flex-wrap:wrap; }
        }
    </style>
    <div class="mle-shell">
        <header class="mle-header">
            <div class="mle-brand">
                <svg class="mle-brand-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M9 3V2h6v1h5v2H4V3h5Zm-3 4h12l-1 14H7L6 7Zm3 2 .5 10h1L10 9H9Zm4 0v10h1V9h-1Z"/></svg>
                <div>
                    <h2 class="mle-title">MessageLoggerEnhanced</h2>
                    <div class="mle-subtitle">Deleted Message Log</div>
                    <div class="mle-count"></div>
                </div>
            </div>
            <div class="mle-header-actions">
                <button class="mle-action mle-download">Download JSON</button>
                <button class="mle-action mle-clear">Delete All Logs</button>
                <button class="mle-close" aria-label="Close">×</button>
            </div>
        </header>
        <section class="mle-tracking-panel">
            <div class="mle-tracking-copy">
                <div class="mle-tracking-title">Tracking location</div>
                <div class="mle-tracking-description">Change what gets cached and logged without opening Vencord settings.</div>
            </div>
            <div class="mle-tracking-actions">
                <select class="mle-tracking-mode" aria-label="Tracking location">
                    <option value="private">Private Messages only</option>
                    <option value="servers">Servers only</option>
                    <option value="both">Private Messages and Servers</option>
                </select>
                <button class="mle-current-server-toggle" type="button"></button>
            </div>
        </section>
        <section class="mle-controls">
            <label class="mle-search-wrap">
                <svg class="mle-search-icon" viewBox="0 0 24 24"><path fill="currentColor" d="m20.7 19.3-4.2-4.2a7 7 0 1 0-1.4 1.4l4.2 4.2 1.4-1.4ZM5 11a6 6 0 1 1 12 0 6 6 0 0 1-12 0Z"/></svg>
                <input class="mle-search" type="search" placeholder="Search messages..." autocomplete="off">
            </label>
            <select class="mle-sort" aria-label="Sort deleted messages">
                <option value="newest">Newest First</option>
                <option value="oldest">Oldest First</option>
            </select>
        </section>
        <main class="mle-list"></main>
        <footer class="mle-footer">
            <div class="mle-footer-text"></div>
            <div class="mle-pagination">
                <button class="mle-page-control mle-previous" aria-label="Previous page">‹</button>
                <button class="mle-page-control mle-page-number" disabled>1</button>
                <button class="mle-page-control mle-next" aria-label="Next page">›</button>
            </div>
        </footer>
    </div>`;

    document.body.appendChild(dialog);
    logDialog = dialog;

    dialog.querySelector(".mle-close")?.addEventListener("click", closeLogDialog);
    const modeSelect = dialog.querySelector<HTMLSelectElement>(".mle-tracking-mode");
    if (modeSelect) {
        modeSelect.value = trackingMode();
        modeSelect.addEventListener("change", () => {
            const mode = modeSelect.value === "private" || modeSelect.value === "servers"
                ? modeSelect.value
                : "both";
            setTrackingMode(mode);
            updateCurrentServerButton();
        });
    }

    const currentServerButton = dialog.querySelector<HTMLButtonElement>(".mle-current-server-toggle");
    const updateCurrentServerButton = () => {
        if (!currentServerButton) return;
        const channelId = SelectedChannelStore.getChannelId();
        const channel: any = channelId ? ChannelStore.getChannel(channelId) : undefined;
        const guildId = String(channel?.guild_id ?? "");

        if (!guildId) {
            currentServerButton.disabled = true;
            currentServerButton.textContent = "Open a server to manage it";
            currentServerButton.dataset.blocked = "false";
            currentServerButton.dataset.guildId = "";
            return;
        }

        const blocked = blockedGuildIds().has(guildId);
        currentServerButton.disabled = false;
        currentServerButton.dataset.guildId = guildId;
        currentServerButton.dataset.blocked = String(blocked);
        currentServerButton.textContent = blocked
            ? "Start tracking this server"
            : "Stop tracking this server";
    };

    currentServerButton?.addEventListener("click", () => {
        const guildId = currentServerButton.dataset.guildId;
        if (!guildId) return;
        const blocked = blockedGuildIds().has(guildId);
        setGuildTracking(guildId, blocked);
        updateCurrentServerButton();
    });
    updateCurrentServerButton();
    dialog.querySelector(".mle-download")?.addEventListener("click", () =>
        downloadJsonFile(logs.filter(log => log.type === "deleted")));
    dialog.querySelector(".mle-clear")?.addEventListener("click", () => {
        if (confirm("Delete every saved deleted-message log? This cannot be undone."))
            clearDeletedLogs();
    });

    const search = dialog.querySelector<HTMLInputElement>(".mle-search");
    search?.addEventListener("input", () => {
        dialogSearch = search.value;
        dialogPage = 1;
        renderLogDialog();
    });

    const sort = dialog.querySelector<HTMLSelectElement>(".mle-sort");
    sort?.addEventListener("change", () => {
        dialogSort = sort.value === "oldest" ? "oldest" : "newest";
        dialogPage = 1;
        renderLogDialog();
    });

    dialog.querySelector(".mle-previous")?.addEventListener("click", () => {
        dialogPage -= 1;
        renderLogDialog();
    });
    dialog.querySelector(".mle-next")?.addEventListener("click", () => {
        dialogPage += 1;
        renderLogDialog();
    });

    dialog.addEventListener("cancel", event => {
        event.preventDefault();
        closeLogDialog();
    });
    dialog.addEventListener("close", () => {
        if (logDialog === dialog)
            closeLogDialog();
    }, { once: true });
    dialog.addEventListener("click", event => {
        if (event.target === dialog)
            closeLogDialog();
    });

    renderLogDialog();
    dialog.showModal();
}
function updateToolbarBadge() {
    if (!toolbarButton) return;
    const count = logs.filter(log => log.type === "deleted").length;
    toolbarButton.dataset.count = String(count);
    toolbarButton.title = `MessageLoggerEnhanced (${count})`;
    toolbarButton.setAttribute("aria-label", `MessageLoggerEnhanced (${count})`);

    let badge = toolbarButton.querySelector<HTMLElement>(".pml-toolbar-badge");
    if (!badge) {
        badge = document.createElement("span");
        badge.className = "pml-toolbar-badge";
        toolbarButton.appendChild(badge);
    }
    badge.textContent = count > 99 ? "99+" : String(count);
    badge.style.display = count ? "grid" : "none";
}

function injectToolbarButton() {
    const toolbar = document.querySelector<HTMLElement>('section[class*="title_"] div[class*="toolbar_"]:not([data-pml-scanned]), div[class*="toolbar_"]:not([data-pml-scanned])');
    if (!toolbar) return;
    toolbar.dataset.pmlScanned = "true";

    if (document.querySelector("#pml-toolbar-button")) return;

    const button = document.createElement("button");
    button.id = "pml-toolbar-button";
    button.type = "button";
    button.style.cssText = "position:relative;display:grid;place-items:center;width:32px;height:32px;padding:0;border:0;background:transparent;color:var(--interactive-normal);cursor:pointer;border-radius:4px;";
    button.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-4.4 3.3A1 1 0 0 1 3 20.5V6a2 2 0 0 1 2-2Zm2.5 5.25a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm4.5 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm4.5 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z"/></svg><span class="pml-toolbar-badge" style="position:absolute;right:-5px;top:-5px;min-width:16px;height:16px;padding:0 3px;border-radius:8px;place-items:center;font-size:9px;font-weight:700;color:white;background:var(--status-danger);pointer-events:none"></span>`;
    button.addEventListener("mouseenter", () => button.style.background = "var(--background-modifier-hover)");
    button.addEventListener("mouseleave", () => button.style.background = "transparent");
    button.addEventListener("click", openLogDialog);

    // Place it at the left edge of the existing call/pin/member toolbar icons.
    toolbar.insertBefore(button, toolbar.firstChild);
    toolbarButton = button;
    updateToolbarBadge();
}

function startToolbarObserver() {
    injectToolbarButton();
    toolbarObserver = new MutationObserver(() => {
        if (!document.querySelector("#pml-toolbar-button")) {
            toolbarButton = undefined;
            document.querySelectorAll<HTMLElement>('[data-pml-scanned="true"]').forEach(el => delete el.dataset.pmlScanned);
            injectToolbarButton();
        }
    });
    toolbarObserver.observe(document.body, { childList: true, subtree: true });
}

function stopToolbarObserver() {
    toolbarObserver?.disconnect();
    toolbarObserver = undefined;
    toolbarButton?.remove();
    toolbarButton = undefined;
    closeLogDialog();
    document.querySelectorAll<HTMLElement>('[data-pml-scanned="true"]').forEach(el => delete el.dataset.pmlScanned);
}


function retainedElementId(channelId: string, messageId: string): string {
    return `mle-retained-${channelId}-${messageId}`;
}

function removeRetainedMessage(channelId: string, messageId: string) {
    const key = cacheKey(channelId, messageId);
    retainedDeletedElements.get(key)?.remove();
    retainedDeletedElements.delete(key);
    document.getElementById(retainedElementId(channelId, messageId))?.remove();
}

function buildRetainedDeletedMessage(message: CachedMessage): HTMLElement {
    const element = document.createElement("div");
    element.id = retainedElementId(message.channelId, message.messageId);
    element.className = "mle-retained-deleted-message";
    element.dataset.channelId = message.channelId;
    element.dataset.messageId = message.messageId;

    const displayName = escapeHtml(message.author.globalName || message.author.username);
    const username = escapeHtml(message.author.username);
    const avatar = escapeHtml(avatarUrl(message.author));
    const timestamp = message.messageTimestamp
        ? new Date(message.messageTimestamp).toLocaleString()
        : "Unknown time";
    const content = escapeHtml(message.content || "(no text content)");

    const attachments = message.attachments.length
        ? `<div class="mle-chat-attachments">${message.attachments.map(attachment => {
            const url = escapeHtml(attachment.url ?? attachment.proxyUrl ?? "");
            const name = escapeHtml(attachment.filename);
            return url
                ? `<a href="${url}" target="_blank" rel="noreferrer">${name}</a>`
                : `<span>${name}</span>`;
        }).join("")}</div>`
        : "";

    element.innerHTML = `
        <img class="mle-chat-avatar" src="${avatar}" alt="">
        <div class="mle-chat-body">
            <div class="mle-chat-header">
                <strong>${displayName}</strong>
                <span>@${username}</span>
                <time>${escapeHtml(timestamp)}</time>
                <span class="mle-chat-deleted-badge">Deleted</span>
            </div>
            <div class="mle-chat-content">${content}</div>
            ${attachments}
        </div>`;

    return element;
}

function retainDeletedMessageInChat(message: CachedMessage, originalElement?: Element | null) {
    if (!settings.store.keepDeletedMessagesInChat)
        return;

    if (!shouldTrackLocation(message.channelId, message.guildId))
        return;

    removeRetainedMessage(message.channelId, message.messageId);

    const retained = buildRetainedDeletedMessage(message);
    const key = cacheKey(message.channelId, message.messageId);
    const originalParent = originalElement?.parentElement ?? null;
    const originalNextSibling = originalElement?.nextSibling ?? null;

    const insert = () => {
        if (document.getElementById(retained.id))
            return;

        // Never inject a deleted message into a different open channel.
        if (SelectedChannelStore.getChannelId() !== message.channelId)
            return;

        if (originalParent?.isConnected) {
            if (originalNextSibling && originalNextSibling.parentNode === originalParent)
                originalParent.insertBefore(retained, originalNextSibling);
            else
                originalParent.appendChild(retained);
        } else {
            const messageList = document.querySelector<HTMLElement>('[data-list-id="chat-messages"]');
            if (!messageList)
                return;

            // The fallback is permitted only after confirming the selected channel.
            messageList.appendChild(retained);
        }

        retainedDeletedElements.set(key, retained);
    };

    // Discord removes the normal message after the delete dispatch. Reinsert after React settles.
    setTimeout(insert, 30);
    setTimeout(insert, 250);
}

function addGlobalChatStyles() {
    if (document.getElementById("mle-global-styles"))
        return;

    const style = document.createElement("style");
    style.id = "mle-global-styles";
    style.textContent = `
        .mle-retained-deleted-message {
            display:grid;
            grid-template-columns:40px minmax(0,1fr);
            gap:12px;
            margin:4px 16px 4px 72px;
            padding:12px 14px;
            border:1px solid rgba(242,63,67,.68);
            border-left:4px solid #f23f43;
            border-radius:7px;
            background:linear-gradient(90deg,rgba(242,63,67,.20),rgba(242,63,67,.09));
            color:var(--text-normal,#dbdee1);
            box-shadow:0 2px 8px rgba(0,0,0,.25);
        }
        .mle-chat-avatar {
            width:40px;
            height:40px;
            border-radius:50%;
            object-fit:cover;
        }
        .mle-chat-body { min-width:0; }
        .mle-chat-header {
            display:flex;
            align-items:center;
            flex-wrap:wrap;
            gap:8px;
            margin-bottom:5px;
        }
        .mle-chat-header strong { color:var(--header-primary,#f2f3f5); }
        .mle-chat-header span,.mle-chat-header time {
            color:var(--text-muted,#949ba4);
            font-size:12px;
        }
        .mle-chat-deleted-badge {
            padding:2px 7px;
            border-radius:4px;
            color:#fff !important;
            background:#da373c;
            font-weight:700;
        }
        .mle-chat-content {
            color:#ff7b7f;
            font-size:15px;
            line-height:1.45;
            white-space:pre-wrap;
            overflow-wrap:anywhere;
        }
        .mle-chat-attachments {
            display:flex;
            flex-wrap:wrap;
            gap:8px;
            margin-top:8px;
        }
        @keyframes mleJumpPulse {
            0%,100% { box-shadow:0 2px 8px rgba(0,0,0,.25); }
            20%,70% { box-shadow:0 0 0 3px rgba(242,63,67,.72),0 0 28px rgba(242,63,67,.45); }
        }
        .mle-retained-deleted-message.mle-jump-highlight {
            animation:mleJumpPulse 1.1s ease-in-out 2;
        }
        .mle-chat-attachments a,.mle-chat-attachments span {
            padding:5px 8px;
            border-radius:5px;
            color:var(--text-link,#00a8fc);
            background:rgba(0,0,0,.22);
        }
    `;
    document.head.appendChild(style);
}

function shouldIgnore(message: { author?: StoredAuthor | any; } | undefined): boolean {
    if (!message) return true;

    const currentUserId = UserStore.getCurrentUser()?.id;
    return (settings.store.ignoreBots && message.author?.bot)
        || (settings.store.ignoreSelf && message.author?.id === currentUserId);
}

function handleCreate(event: { message?: any; optimistic?: boolean; }) {
    if (!event.message || event.optimistic) return;
    rememberMessage(event.message);
}

function handleDelete(event: { channelId: string; id: string; }) {
    const channelId = String(event.channelId ?? "");
    const messageId = String(event.id ?? "");
    if (!channelId || !messageId) return;

    const originalElement = document.getElementById(`chat-messages-${channelId}-${messageId}`)
        ?? document.querySelector(`[data-list-item-id*="${channelId}-${messageId}"]`);

    const message = removeCachedMessage(channelId, messageId);
    if (!message || shouldIgnore(message) || !shouldTrackLocation(channelId, message.guildId)) return;

    retainDeletedMessageInChat(message, originalElement);

    addLog({
        key: `deleted:${channelId}:${messageId}`,
        type: "deleted",
        messageId,
        channelId,
        guildId: message.guildId,
        author: message.author,
        content: message.content,
        attachments: message.attachments,
        messageTimestamp: message.messageTimestamp,
        loggedAt: new Date().toISOString()
    });
}

function handleBulkDelete(event: { channelId: string; ids: string[]; }) {
    for (const id of event.ids ?? [])
        handleDelete({ channelId: event.channelId, id });
}

function handleUpdate(event: { message?: any; }) {
    const incoming = event.message;
    const channelId = String(incoming?.channel_id ?? incoming?.channelId ?? "");
    const messageId = String(incoming?.id ?? "");
    if (!channelId || !messageId) return;

    const channel: any = ChannelStore.getChannel(channelId);
    if (!shouldTrackLocation(channelId, channel?.guild_id))
        return;

    const key = cacheKey(channelId, messageId);
    const previous = messageCache[key];
    const updated = makeCachedMessage(incoming, previous);
    if (!updated) return;

    messageCache[key] = updated;
    trimMessageCache();
    scheduleCacheSave();

    // Discord can emit partial MESSAGE_UPDATE events that do not contain content.
    // Only create an edit log when we know both the old and new text.
    if (!previous || incoming.content == null) return;

    const oldContent = previous.content;
    const newContent = String(incoming.content);
    if (oldContent === newContent || shouldIgnore(updated)) return;

    const editTimestamp = incoming.edited_timestamp
        ? String(incoming.edited_timestamp)
        : new Date().toISOString();

    addLog({
        key: `edited:${channelId}:${messageId}:${editTimestamp}`,
        type: "edited",
        messageId,
        channelId,
        guildId: updated.guildId,
        author: updated.author,
        content: newContent,
        oldContent,
        newContent,
        attachments: updated.attachments,
        messageTimestamp: updated.messageTimestamp,
        loggedAt: editTimestamp
    });
}


const patchGuildContextMenu: NavContextMenuPatchCallback = (children, props: any) => {
    const guildId = String(props?.guild?.id ?? props?.guildId ?? "");
    if (!guildId) return;

    const blocked = blockedGuildIds().has(guildId);
    children.push(
        <Menu.MenuItem
            id="message-logger-enhanced-toggle-guild"
            label={blocked ? "MessageLoggerEnhanced: Track this server" : "MessageLoggerEnhanced: Stop tracking this server"}
            action={() => setGuildTracking(guildId, blocked)}
        />
    );
};

const patchChannelContextMenu: NavContextMenuPatchCallback = (children, { channel }) => {
    if (!channel?.id) return;

    const group = findGroupChildrenByChildId("mark-channel-read", children) ?? children;
    const channelLogs = getChannelLogs(channel.id);

    group.push(
        <Menu.MenuItem
            id="message-logger-enhanced-copy"
            label={`Copy MessageLoggerEnhanced Logs (${channelLogs.length})`}
            disabled={!channelLogs.length}
            action={() => exportLogs(channelLogs)}
        />,
        <Menu.MenuItem
            id="message-logger-enhanced-copy-json"
            label="Copy MessageLoggerEnhanced Logs as JSON"
            disabled={!channelLogs.length}
            action={() => exportJson(channelLogs)}
        />
    );
};

const settings = definePluginSettings({
    maximumLogs: {
        type: OptionType.NUMBER,
        description: "Maximum number of logs stored permanently",
        default: 10000,
        onChange: () => {
            trimLogs();
            scheduleSave();
        }
    },
    trackingMode: {
        type: OptionType.SELECT,
        description: "Choose where messages are cached, logged and restored in chat",
        options: [
            { label: "Private Messages only", value: "private", default: true },
            { label: "Servers only", value: "servers" },
            { label: "Private Messages and Servers", value: "both" }
        ],
        onChange: () => {
            purgeUntrackedCache();
            for (const [key, element] of retainedDeletedElements) {
                const [channelId] = key.split(":");
                if (!shouldTrackLocation(channelId)) {
                    element.remove();
                    retainedDeletedElements.delete(key);
                }
            }
        }
    },
    keepDeletedMessagesInChat: {
        type: OptionType.BOOLEAN,
        description: "Keep deleted messages visible in chat with a red Deleted marker",
        default: true
    },
    blockedServerIds: {
        type: OptionType.STRING,
        description: "Server IDs that must not be tracked, separated by commas. You can also right-click a server icon and choose Stop tracking this server.",
        default: "",
        onChange: () => purgeUntrackedCache()
    },
    trackingHelp: {
        type: OptionType.COMPONENT,
        description: "Server tracking controls",
        component: () => (
            <div style={{ padding: "10px 12px", borderRadius: 8, background: "var(--background-secondary)" }}>
                <b>Per-server control:</b> Right-click a server icon, then choose <b>MessageLoggerEnhanced: Stop tracking this server</b>.
            </div>
        )
    },
    maximumCachedMessages: {
        type: OptionType.NUMBER,
        description: "Maximum number of ordinary messages kept in the private cache so future deletions can be recovered",
        default: 50000,
        onChange: () => {
            trimMessageCache();
            scheduleCacheSave();
        }
    },
    ignoreBots: {
        type: OptionType.BOOLEAN,
        description: "Do not permanently save logs from bots",
        default: false
    },
    ignoreSelf: {
        type: OptionType.BOOLEAN,
        description: "Do not permanently save your own deleted or edited messages",
        default: false
    },
    copyAllLogs: {
        type: OptionType.COMPONENT,
        description: "Copy all saved logs as readable text",
        component: () => (
            <button
                className="vc-button vc-button-filled vc-button-color-brand vc-button-size-small"
                onClick={() => exportLogs()}
            >
                Copy All MessageLoggerEnhanced Logs
            </button>
        )
    },
    copyAllLogsJson: {
        type: OptionType.COMPONENT,
        description: "Copy every saved log as JSON",
        component: () => (
            <button
                className="vc-button vc-button-filled vc-button-color-primary vc-button-size-small"
                onClick={() => exportJson()}
            >
                Copy All Logs as JSON
            </button>
        )
    },
    clearAllLogs: {
        type: OptionType.COMPONENT,
        description: "Permanently erase all saved message logs",
        component: () => (
            <button
                style={{ background: "var(--status-danger)", color: "white", border: 0, borderRadius: 4, padding: "8px 14px", cursor: "pointer" }}
                onClick={() => {
                    logs = [];
                    void DataStore.set(STORE_KEY, logs);
                    Toasts.show({
                        message: "All saved message logs were cleared.",
                        type: Toasts.Type.SUCCESS,
                        id: Toasts.genId()
                    });
                }}
            >
                Clear All MessageLoggerEnhanced Logs
            </button>
        )
    }
});

export default definePlugin({
    name: "MessageLoggerEnhanced",
    description: "Standalone persistent deleted-message and edit logger with search, JSON export and a Discord-style log viewer.",
    authors: [
        { name: "twitch.tv/yonaaw_", id: 0n },
        { name: "twitch.tv/Chihiroqt", id: 0n }
    ],
    tags: ["Chat", "Utility"],
    settings,

    contextMenus: {
        "channel-context": patchChannelContextMenu,
        "thread-context": patchChannelContextMenu,
        "user-context": patchChannelContextMenu,
        "gdm-context": patchChannelContextMenu,
        "guild-context": patchGuildContextMenu
    },

    async start() {
        addGlobalChatStyles();

        const [storedLogs, storedCache, legacyLogs, legacyCache] = await Promise.all([
            DataStore.get<PersistentLog[]>(STORE_KEY),
            DataStore.get<Record<string, CachedMessage>>(CACHE_KEY),
            DataStore.get<PersistentLog[]>(LEGACY_STORE_KEY),
            DataStore.get<Record<string, CachedMessage>>(LEGACY_CACHE_KEY)
        ]);

        logs = Array.isArray(storedLogs)
            ? storedLogs
            : Array.isArray(legacyLogs)
                ? legacyLogs
                : [];

        messageCache = storedCache && typeof storedCache === "object" && !Array.isArray(storedCache)
            ? storedCache
            : legacyCache && typeof legacyCache === "object" && !Array.isArray(legacyCache)
                ? legacyCache
                : {};

        if (!Array.isArray(storedLogs) && Array.isArray(legacyLogs))
            void DataStore.set(STORE_KEY, logs);
        if ((!storedCache || Array.isArray(storedCache)) && legacyCache && typeof legacyCache === "object" && !Array.isArray(legacyCache))
            void DataStore.set(CACHE_KEY, messageCache);

        trimLogs();
        trimMessageCache();
        purgeUntrackedCache();
        scheduleSave();
        scheduleCacheSave();

        FluxDispatcher.subscribe("MESSAGE_CREATE", handleCreate);
        FluxDispatcher.subscribe("MESSAGE_DELETE", handleDelete);
        FluxDispatcher.subscribe("MESSAGE_DELETE_BULK", handleBulkDelete);
        FluxDispatcher.subscribe("MESSAGE_UPDATE", handleUpdate);
        startToolbarObserver();
    },

    stop() {
        FluxDispatcher.unsubscribe("MESSAGE_CREATE", handleCreate);
        FluxDispatcher.unsubscribe("MESSAGE_DELETE", handleDelete);
        FluxDispatcher.unsubscribe("MESSAGE_DELETE_BULK", handleBulkDelete);
        FluxDispatcher.unsubscribe("MESSAGE_UPDATE", handleUpdate);
        stopToolbarObserver();

        if (saveTimer) {
            clearTimeout(saveTimer);
            saveTimer = undefined;
        }
        if (cacheSaveTimer) {
            clearTimeout(cacheSaveTimer);
            cacheSaveTimer = undefined;
        }
        void DataStore.set(STORE_KEY, logs);
        void DataStore.set(CACHE_KEY, messageCache);
    }
});
