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
    bookmarked?: boolean;
    ghostPing?: boolean;
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
const READ_KEY = "MessageLoggerEnhanced_last_viewed_v1";
const EXTRA_KEY = "MessageLoggerEnhanced_extra_v1";
const LEGACY_STORE_KEY = "PersistentMessageLogger_logs_v1";
const LEGACY_CACHE_KEY = "PersistentMessageLogger_message_cache_v1";
let logs: PersistentLog[] = [];
let paused = false;
let ignoredUsers = "";
let mediaCacheEnabled = false;
let mediaLimitMb = 100;
let filterAuthor = "";
let filterChannel = "";
let filterSince = "";
let filterUntil = "";
let bookmarksOnly = false;
let ghostsOnly = false;
let mediaUsedBytes = 0;
let mediaDbPromise: Promise<IDBDatabase> | undefined;
const mediaPending = new Set<string>();
let lastViewedAt = 0;
let messageCache: Record<string, CachedMessage> = {};
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let cacheSaveTimer: ReturnType<typeof setTimeout> | undefined;
let toolbarObserver: MutationObserver | undefined;
let toolbarButton: HTMLButtonElement | undefined;
let logDialog: HTMLDialogElement | undefined;
let dialogSearch = "";
let dialogSort: "newest" | "oldest" = "newest";
let dialogLogType: "all" | "deleted" | "edited" = "all";
let dialogContentFilter: "all" | "text" | "images" | "gifs" = "all";
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

function ignoredUserSet(): Set<string> {
    return new Set(ignoredUsers.split(/[\s,]+/).filter(Boolean));
}

function ignoredAuthor(user: { id: string }): boolean {
    return ignoredUserSet().has(String(user.id));
}

function saveExtraState() {
    void DataStore.set(EXTRA_KEY, { paused, ignoredUsers, mediaCacheEnabled, mediaLimitMb });
}

function updatePanelState() {
    if (!logDialog?.isConnected) return;
    const pause = logDialog.querySelector<HTMLButtonElement>(".mle-pause");
    if (pause) pause.textContent = paused ? "Resume logging" : "Pause logging";
    const storage = logDialog.querySelector<HTMLElement>(".mle-storage-info");
    if (storage) storage.textContent = `Logs: ${logs.length} · Cache: ${Object.keys(messageCache).length} · Media: ${(mediaUsedBytes / 1048576).toFixed(1)} MB / ${mediaLimitMb} MB`;
}

function openMediaDb(): Promise<IDBDatabase> {
    if (mediaDbPromise) return mediaDbPromise;
    return mediaDbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open("MessageLoggerEnhancedMedia", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("media", { keyPath: "url" });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function listMedia(): Promise<Array<{url: string; data: Blob; savedAt: number; size: number}>> {
    const db = await openMediaDb();
    return new Promise((resolve, reject) => {
        const request = db.transaction("media", "readonly").objectStore("media").getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function refreshMediaSize() {
    try {
        mediaUsedBytes = (await listMedia()).reduce((sum, item) => sum + item.size, 0);
        updatePanelState();
    } catch (error) { console.warn("MessageLoggerEnhanced media database error", error); }
}

async function pruneMedia() {
    const entries = (await listMedia()).sort((a, b) => a.savedAt - b.savedAt);
    let total = entries.reduce((sum, item) => sum + item.size, 0);
    const limit = Math.max(1, mediaLimitMb) * 1048576;
    if (total <= limit) { mediaUsedBytes = total; updatePanelState(); return; }
    const db = await openMediaDb();
    for (const entry of entries) {
        if (total <= limit) break;
        await new Promise<void>((resolve, reject) => {
            const r = db.transaction("media", "readwrite").objectStore("media").delete(entry.url);
            r.onsuccess = () => resolve(); r.onerror = () => reject(r.error);
        });
        total -= entry.size;
    }
    mediaUsedBytes = total;
    updatePanelState();
}

async function cacheMedia(attachments: StoredAttachment[]) {
    if (!mediaCacheEnabled || paused) return;
    for (const attachment of attachments) {
        const url = attachment.url;
        if (!url || mediaPending.has(url) || !(/\.(?:png|jpe?g|webp|gif)(?:\?|$)/i.test(url) || /^image\//.test(attachment.contentType ?? ""))) continue;
        mediaPending.add(url);
        try {
            const response = await fetch(url);
            if (!response.ok) continue;
            const data = await response.blob();
            if (data.size > 20 * 1048576 || !data.type.startsWith("image/")) continue;
            const db = await openMediaDb();
            await new Promise<void>((resolve, reject) => {
                const request = db.transaction("media", "readwrite").objectStore("media").put({ url, data, size: data.size, savedAt: Date.now() });
                request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
            });
            await pruneMedia();
        } catch (error) { console.debug("MessageLoggerEnhanced: media caching failed", error); }
        finally { mediaPending.delete(url); }
    }
}

async function openCachedMedia(url: string) {
    const db = await openMediaDb();
    const item = await new Promise<{data: Blob} | undefined>((resolve, reject) => {
        const request = db.transaction("media", "readonly").objectStore("media").get(url);
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    if (!item) { alert("This attachment was not cached locally. Its Discord URL may have expired."); return; }
    const blobUrl = URL.createObjectURL(item.data);
    const a = document.createElement("a"); a.href = blobUrl; a.target = "_blank"; a.rel = "noreferrer";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
}

function makeBackup() {
    const blob = new Blob([JSON.stringify({ format: "MessageLoggerEnhancedBackup", version: 1, logs, messageCache, options: { paused, ignoredUsers, mediaCacheEnabled, mediaLimitMb } }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `MessageLoggerEnhanced-backup-${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 3000);
}

async function importBackup(file: File) {
    if (file.size > 35 * 1048576) throw Error("Backup file too large (35MB limit)");
    const parsed = JSON.parse(await file.text());
    if (parsed?.format !== "MessageLoggerEnhancedBackup" || parsed.version !== 1 || !Array.isArray(parsed.logs)) throw Error("Not a valid MessageLoggerEnhanced backup");
    const byKey = new Map<string, PersistentLog>(logs.map(log => [log.key, log]));
    for (const log of parsed.logs) {
        if (!log || typeof log.key !== "string" || typeof log.messageId !== "string" || typeof log.channelId !== "string" || !["edited", "deleted"].includes(log.type)) continue;
        byKey.set(log.key, log);
    }
    logs = [...byKey.values()];
    if (parsed.messageCache && typeof parsed.messageCache === "object" && !Array.isArray(parsed.messageCache)) {
        for (const [key, item] of Object.entries(parsed.messageCache)) {
            const candidate = item as CachedMessage;
            if (candidate?.messageId && candidate?.channelId) messageCache[key] = candidate;
        }
    }
    trimLogs(); trimMessageCache(); purgeUntrackedCache(); scheduleSave(); scheduleCacheSave(); updateToolbarBadge(); renderLogDialog();
}

function getEditTimeline(log: PersistentLog): string[] {
    const edits = logs.filter(x => x.type === "edited" && x.channelId === log.channelId && x.messageId === log.messageId)
        .sort((a,b) => Date.parse(a.loggedAt) - Date.parse(b.loggedAt));
    if (!edits.length) return [];
    return [String(edits[0].oldContent ?? ""), ...edits.map(x => String(x.newContent ?? x.content ?? ""))];
}

function showEditTimeline(log: PersistentLog) {
    const timeline = getEditTimeline(log);
    alert(timeline.map((version, index) => `Version ${index + 1}:\n${version || "(empty)"}`).join("\n\n──────────\n\n"));
}

function isGhostPing(message: CachedMessage): boolean {
    const me = UserStore.getCurrentUser()?.id;
    if (!me) return false;
    return new RegExp(`<@!?${me}>`).test(message.content)
        || message.content.includes("@everyone")
        || message.content.includes("@here");
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

    if (message?.author?.id && ignoredAuthor({ id: String(message.author.id) })) return undefined;
    const channel: any = ChannelStore.getChannel(channelId);
    if (paused || !shouldTrackLocation(channelId, channel?.guild_id))
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
    updatePanelState();
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

function getHighlightTerms(): string[] {
    const seen = new Set<string>();

    return dialogSearch
        .trim()
        .split(/\s+/)
        .map(term => term.trim())
        .filter(term => {
            const key = term.toLocaleLowerCase();
            if (!term || seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .sort((a, b) => b.length - a.length);
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightSearchText(value: unknown): string {
    const text = String(value ?? "");
    const terms = getHighlightTerms();
    if (!terms.length)
        return escapeHtml(text);

    const expression = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "giu");
    let output = "";
    let lastIndex = 0;

    for (const match of text.matchAll(expression)) {
        const index = match.index ?? 0;
        output += escapeHtml(text.slice(lastIndex, index));
        output += `<mark class="mle-search-highlight">${escapeHtml(match[0])}</mark>`;
        lastIndex = index + match[0].length;
    }

    output += escapeHtml(text.slice(lastIndex));
    return output;
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
    const blob = new Blob([JSON.stringify(entries, null, 2)], {
        type: "application/json;charset=utf-8"
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");

    anchor.href = url;
    anchor.download = `MessageLoggerEnhanced-logs-${stamp}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);

    Toasts.show({
        message: `Downloaded ${entries.length} message log${entries.length === 1 ? "" : "s"}.`,
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

function clearVisibleLogType() {
    if (dialogLogType === "deleted") {
        clearDeletedLogs();
        return;
    }

    if (dialogLogType === "edited") {
        logs = logs.filter(log => log.type !== "edited");
    } else {
        for (const log of logs)
            if (log.type === "deleted")
                removeRetainedMessage(log.channelId, log.messageId);
        logs = [];
    }

    scheduleSave();
    updateToolbarBadge();
    dialogPage = 1;
    renderLogDialog();
}


function isGifAttachment(attachment: StoredAttachment): boolean {
    const contentType = String(attachment.contentType ?? "").toLowerCase();
    const filename = String(attachment.filename ?? "").toLowerCase();
    const url = String(attachment.url ?? attachment.proxyUrl ?? "").toLowerCase();

    return contentType === "image/gif"
        || filename.endsWith(".gif")
        || url.includes(".gif")
        || url.includes("tenor.com")
        || url.includes("giphy.com");
}

function isImageAttachment(attachment: StoredAttachment): boolean {
    const contentType = String(attachment.contentType ?? "").toLowerCase();
    const filename = String(attachment.filename ?? "").toLowerCase();

    return contentType.startsWith("image/")
        || /\.(png|jpe?g|webp|bmp|avif)$/i.test(filename);
}

function matchesContentFilter(log: PersistentLog): boolean {
    if (dialogContentFilter === "all")
        return true;

    const hasGif = log.attachments.some(isGifAttachment)
        || /(?:tenor\.com|giphy\.com|\.gif(?:\?|$))/i.test(log.content);

    const hasImage = log.attachments.some(attachment =>
        isImageAttachment(attachment) && !isGifAttachment(attachment)
    );

    if (dialogContentFilter === "gifs")
        return hasGif;

    if (dialogContentFilter === "images")
        return hasImage;

    // "Text messages" means entries with actual text that are not image/GIF-only posts.
    return Boolean(log.content.trim()) && !hasGif && !hasImage;
}

function normalizeSearchValue(value: unknown): string {
    return String(value ?? "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLocaleLowerCase()
        .replace(/[^\p{L}\p{N}@#._:/-]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function getSearchHaystack(log: PersistentLog): string {
    const channel: any = ChannelStore.getChannel(log.channelId);
    const channelName = channel?.name ? `#${channel.name}` : "";
    const serverId = log.guildId ?? channel?.guild_id ?? "";
    const date = new Date(log.loggedAt);

    return normalizeSearchValue([
        log.type,
        log.type === "deleted" ? "deleted" : "edited",
        log.author.globalName,
        log.author.username,
        `@${log.author.username}`,
        log.author.id,
        log.content,
        log.oldContent,
        log.newContent,
        log.channelId,
        channelName,
        channelLabel(log.channelId),
        serverId,
        log.messageId,
        log.loggedAt,
        Number.isNaN(date.getTime()) ? "" : date.toLocaleString(),
        Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(),
        ...log.attachments.flatMap(attachment => [
            attachment.filename,
            attachment.contentType,
            attachment.url,
            attachment.proxyUrl
        ])
    ].join(" "));
}

function matchesSearch(log: PersistentLog, rawQuery: string): boolean {
    const normalizedQuery = normalizeSearchValue(rawQuery);
    if (!normalizedQuery)
        return true;

    const tokens = normalizedQuery.split(" ").filter(Boolean);
    const haystack = getSearchHaystack(log);

    // Every entered word must be present, but the words can appear in any order
    // and across different fields (for example: "starlight edited general").
    return tokens.every(token => haystack.includes(token));
}

function getVisibleLogs() {
    const entries = logs
        .filter(log => !bookmarksOnly || log.bookmarked)
        .filter(log => !ghostsOnly || log.ghostPing)
        .filter(log => !filterAuthor || [log.author.username, log.author.globalName, log.author.id].some(v => String(v ?? "").toLowerCase().includes(filterAuthor.toLowerCase())))
        .filter(log => !filterChannel || [log.channelId, channelLabel(log.channelId), log.guildId].some(v => String(v ?? "").toLowerCase().includes(filterChannel.toLowerCase())))
        .filter(log => !filterSince || Date.parse(log.loggedAt) >= new Date(filterSince).getTime())
        .filter(log => !filterUntil || Date.parse(log.loggedAt) < new Date(filterUntil).getTime() + 86400000)
        .filter(log => dialogLogType === "all" || log.type === dialogLogType)
        .filter(matchesContentFilter)
        .filter(log => matchesSearch(log, dialogSearch));

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

    const entries = getVisibleLogs();
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

    const allCount = logs.length;
    const deletedCount = logs.filter(log => log.type === "deleted").length;
    const editedCount = logs.filter(log => log.type === "edited").length;
    const activeLabel = dialogLogType === "deleted" ? "deleted" : dialogLogType === "edited" ? "edited" : "message";
    if (count)
        count.textContent = `${deletedCount} deleted • ${editedCount} edited`;
    if (footerText)
        footerText.textContent = `Displaying ${firstShown} – ${lastShown} of ${entries.length} ${activeLabel} logs`;
    if (pageButton)
        pageButton.textContent = String(dialogPage);
    if (previous)
        previous.disabled = dialogPage <= 1;
    if (next)
        next.disabled = dialogPage >= totalPages;
    if (download)
        download.disabled = entries.length === 0;
    if (clear)
        clear.disabled = allCount === 0;
    if (!list) return;

    if (!pageEntries.length) {
        list.innerHTML = `<div class="mle-empty">${dialogSearch ? "No logs match your search and selected filters." : "No deleted or edited messages have been logged yet."}</div>`;
        return;
    }

    updatePanelState();
    list.innerHTML = pageEntries.map(log => {
        const displayName = highlightSearchText(log.author.globalName || log.author.username);
        const username = highlightSearchText(log.author.username);
        const content = highlightSearchText(log.content || "(no text content)");
        const oldContent = highlightSearchText(log.oldContent ?? "");
        const newContent = highlightSearchText(log.newContent ?? log.content ?? "");
        const isEdited = log.type === "edited";
        const statusLabel = isEdited ? "Edited" : "Deleted";
        const channel = highlightSearchText(channelLabel(log.channelId));
        const fullTime = highlightSearchText(new Date(log.loggedAt).toLocaleString());
        const relative = highlightSearchText(relativeTime(log.loggedAt));
        const avatar = escapeHtml(avatarUrl(log.author));

        const attachmentBlock = log.attachments.length
            ? `<div class="mle-attachments">${log.attachments.map(attachment => {
                const href = escapeHtml(attachment.url ?? attachment.proxyUrl ?? "");
                const filename = highlightSearchText(attachment.filename);
                const isImage = String(attachment.contentType ?? "").startsWith("image/");
                return href
                    ? `<a class="mle-attachment" href="${href}" target="_blank" rel="noreferrer">
                        ${isImage ? `<img src="${href}" alt="">` : `<span class="mle-file-icon">▧</span>`}
                        <span>${filename}</span>
                    </a><button class="mle-cache-open mle-tool" data-media-url="${href}" title="View cached copy" type="button">Cached copy</button>`
                    : `<span class="mle-attachment"><span class="mle-file-icon">▧</span><span>${filename}</span></span>`;
            }).join("")}</div>`
            : "";

        return `<article class="mle-entry ${log.bookmarked ? "mle-bookmarked" : ""} ${isEdited ? "mle-entry-edited" : ""} ${dialogSearch.trim() ? "mle-search-result" : ""}" data-jump-key="${escapeHtml(log.key)}" title="Click to open this message in chat">
            <img class="mle-avatar" src="${avatar}" alt="">
            <div class="mle-entry-body">
                <div class="mle-entry-header">
                    <div class="mle-author-line">
                        <strong>${displayName}</strong>
                        <span>@${username}</span>
                    </div>
                    <span class="mle-relative">${relative}</span>
                </div>
                ${isEdited
                    ? `<div class="mle-edit-history">
                        <div class="mle-edit-version"><span>Before</span><div>${oldContent || "(empty message)"}</div></div>
                        <div class="mle-edit-arrow">→</div>
                        <div class="mle-edit-version mle-edit-after"><span>After</span><div>${newContent || "(empty message)"}</div></div>
                    </div>`
                    : `<div class="mle-message">${content}</div>`}
                ${attachmentBlock}
                ${isEdited ? `<button class="mle-timeline" data-timeline-key="${escapeHtml(log.key)}">View all ${getEditTimeline(log).length} versions</button>` : ""}
                <div class="mle-meta-row">
                    <span class="mle-channel-pill">${channel}</span>
                    <span class="mle-deleted-pill ${isEdited ? "mle-edited-pill" : ""}">${highlightSearchText(statusLabel)}</span>
                    ${log.ghostPing ? `<span class="mle-ghost-pill">Ghost ping</span>` : ""}
                </div>
                <div class="mle-id-line">
                    Channel: ${highlightSearchText(log.channelId)}
                    <b>•</b>
                    Message ID: ${highlightSearchText(log.messageId)}
                    <b>•</b>
                    ${statusLabel}: ${fullTime}
                </div>
            </div>
            <button class="mle-bookmark" data-bookmark-key="${escapeHtml(log.key)}" title="Toggle bookmark" aria-label="Toggle bookmark">${log.bookmarked ? "★" : "☆"}</button>
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

    list.querySelectorAll<HTMLButtonElement>(".mle-cache-open").forEach(button => button.addEventListener("click", event => {
        event.preventDefault(); event.stopPropagation();
        if (button.dataset.mediaUrl) void openCachedMedia(button.dataset.mediaUrl).catch(e => alert(String(e)));
    }));
    list.querySelectorAll<HTMLButtonElement>(".mle-bookmark").forEach(button => button.addEventListener("click", event => {
        event.stopPropagation();
        const log = logs.find(item => item.key === button.dataset.bookmarkKey);
        if (log) { log.bookmarked = !log.bookmarked; scheduleSave(); renderLogDialog(); }
    }));
    list.querySelectorAll<HTMLButtonElement>(".mle-timeline").forEach(button => button.addEventListener("click", event => {
        event.stopPropagation();
        const log = logs.find(item => item.key === button.dataset.timelineKey);
        if (log) showEditTimeline(log);
    }));
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
    dialogLogType = "all";
    dialogContentFilter = "all";
    dialogPage = 1;
    lastViewedAt = Date.now();
    void DataStore.set(READ_KEY, lastViewedAt);
    updateToolbarBadge();

    const dialog = document.createElement("dialog");
    dialog.className = "mle-dialog";
    dialog.innerHTML = `<style>
        .mle-extra-tools,.mle-advanced-search { display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:10px 26px;color:#e5e7eb;background:#1c1e24;border-bottom:1px solid #42454d;font-size:12px; }
        .mle-extra-tools label,.mle-advanced-search label { display:flex;gap:5px;align-items:center; }
        .mle-extra-tools input,.mle-advanced-search input {background:#101115;border:1px solid #5b606a;color:white;border-radius:5px;padding:6px;}
        .mle-tool,.mle-timeline {background:#4b55ad;color:white;border:0;border-radius:5px;padding:8px 10px;cursor:pointer;}
        .mle-bookmark {position:absolute;top:72px;right:26px;background:none;border:0;color:#facc15;font-size:24px;cursor:pointer;}
        .mle-bookmarked {box-shadow:inset 0 0 0 1px #facc15;}
        .mle-ghost-pill {color:#fff;background:#a5357b;border-radius:4px;padding:4px 8px;}
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
            min-width:0;
            border:0;
            outline:0;
            color:#f3f4f6 !important;
            background:transparent;
            font-size:16px;
        }
        .mle-search::placeholder { color:#b9c1cf !important; opacity:1; }
        .mle-search-clear {
            width:28px;
            height:28px;
            flex:0 0 auto;
            display:none;
            place-items:center;
            padding:0;
            border:0;
            border-radius:5px;
            cursor:pointer;
            color:#ffffff;
            background:rgba(255,255,255,.10);
            font-size:21px;
            line-height:1;
        }
        .mle-search-clear:hover { background:rgba(255,255,255,.18); }
        .mle-search-clear.mle-visible { display:grid; }
        .mle-search-icon { width:23px; height:23px; color:#d7dce5 !important; flex:0 0 auto; }
        .mle-filter-controls {
            display:flex;
            align-items:center;
            gap:12px;
        }
        .mle-sort,
        .mle-content-filter,
        .mle-log-type {
            min-width:190px;
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
        .mle-entry.mle-search-result {
            border-color:rgba(250,204,21,.72);
            box-shadow:0 0 0 1px rgba(250,204,21,.18),0 7px 22px rgba(0,0,0,.28);
        }
        .mle-search-highlight {
            padding:1px 3px;
            border-radius:3px;
            color:#17120a;
            background:#facc15;
            box-shadow:0 0 0 1px rgba(255,255,255,.18),0 0 10px rgba(250,204,21,.30);
            font:inherit;
            font-weight:800;
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
        .mle-entry-edited { border-left-color:#f0b232 !important; }
        .mle-edited-pill { border-color:rgba(240,178,50,.55) !important; color:#ffd166 !important; }
        .mle-edit-history { display:grid; grid-template-columns:minmax(0,1fr) 30px minmax(0,1fr); gap:10px; align-items:stretch; margin-top:10px; }
        .mle-edit-version { padding:10px 12px; border-radius:6px; background:#191b20; border:1px solid rgba(255,255,255,.10); }
        .mle-edit-version > span { display:block; margin-bottom:5px; color:#b5bac1; font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:.5px; }
        .mle-edit-version > div { color:#ff9da0; white-space:pre-wrap; overflow-wrap:anywhere; }
        .mle-edit-after > div { color:#9ee6a5; }
        .mle-edit-arrow { display:grid; place-items:center; color:#f0b232; font-size:21px; font-weight:800; }
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
            .mle-filter-controls { align-items:stretch; flex-direction:column; }
            .mle-sort,.mle-content-filter,.mle-log-type { width:100%; }
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
                    <div class="mle-subtitle">Deleted & Edited Message Logs</div>
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
        <section class="mle-extra-tools">
            <button class="mle-pause mle-tool">Pause logging</button>
            <label><input type="checkbox" class="mle-bookmarks-only"> Bookmarks only</label>
            <label><input type="checkbox" class="mle-ghosts-only"> Ghost pings only</label>
            <label><input type="checkbox" class="mle-media-enabled"> Cache images/GIFs locally</label>
            <label>Media limit MB <input type="number" class="mle-media-limit" min="1" max="2048" value="100" style="width:66px"></label>
            <label>Ignore user IDs <input type="text" class="mle-ignored-users" placeholder="Comma-separated user IDs"></label>
            <button class="mle-backup mle-tool">Backup JSON</button>
            <button class="mle-restore mle-tool">Restore backup</button>
            <input type="file" class="mle-import-file" accept=".json,application/json" style="display:none">
            <span class="mle-storage-info"></span>
        </section>
        <section class="mle-advanced-search">
            <input class="mle-filter-author" placeholder="Filter user / user ID">
            <input class="mle-filter-channel" placeholder="Filter channel / server ID">
            <label>From <input class="mle-filter-since" type="date"></label>
            <label>To <input class="mle-filter-until" type="date"></label>
            <button class="mle-reset-filters mle-tool">Reset filters</button>
        </section>
        <section class="mle-controls">
            <label class="mle-badge-toggle" style="display:flex;align-items:center;gap:8px;color:#e7e9ee;font-size:13px;white-space:nowrap">
                <input type="checkbox" class="mle-badge-setting" ${settings.store.showUnreadBadge ? "checked" : ""}>
                Notification badge
            </label>
            <label class="mle-search-wrap">
                <svg class="mle-search-icon" viewBox="0 0 24 24"><path fill="currentColor" d="m20.7 19.3-4.2-4.2a7 7 0 1 0-1.4 1.4l4.2 4.2 1.4-1.4ZM5 11a6 6 0 1 1 12 0 6 6 0 0 1-12 0Z"/></svg>
                <input class="mle-search" type="search" placeholder="Search text, user, channel, ID..." autocomplete="off" spellcheck="false">
                <button class="mle-search-clear" type="button" aria-label="Clear search" title="Clear search">×</button>
            </label>
            <div class="mle-filter-controls">
                <select class="mle-log-type" aria-label="Choose log type">
                    <option value="all">Deleted and edited</option>
                    <option value="deleted">Deleted messages only</option>
                    <option value="edited">Edited messages only</option>
                </select>
                <select class="mle-content-filter" aria-label="Filter message content">
                    <option value="all">All deleted content</option>
                    <option value="text">Text messages only</option>
                    <option value="images">Images only</option>
                    <option value="gifs">GIFs only</option>
                </select>
                <select class="mle-sort" aria-label="Sort deleted messages">
                    <option value="newest">Newest First</option>
                    <option value="oldest">Oldest First</option>
                </select>
            </div>
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
    const wireInput = (selector: string, setter: (v: string) => void) => {
        const input = dialog.querySelector<HTMLInputElement>(selector);
        input?.addEventListener("input", () => { setter(input.value); dialogPage = 1; renderLogDialog(); });
    };
    wireInput(".mle-filter-author", v => filterAuthor = v);
    wireInput(".mle-filter-channel", v => filterChannel = v);
    wireInput(".mle-filter-since", v => filterSince = v);
    wireInput(".mle-filter-until", v => filterUntil = v);
    const bookmarked = dialog.querySelector<HTMLInputElement>(".mle-bookmarks-only");
    bookmarked?.addEventListener("change", () => { bookmarksOnly = bookmarked.checked; dialogPage = 1; renderLogDialog(); });
    const ghosts = dialog.querySelector<HTMLInputElement>(".mle-ghosts-only");
    ghosts?.addEventListener("change", () => { ghostsOnly = ghosts.checked; dialogPage = 1; renderLogDialog(); });
    const media = dialog.querySelector<HTMLInputElement>(".mle-media-enabled");
    if (media) { media.checked = mediaCacheEnabled; media.addEventListener("change", () => { mediaCacheEnabled = media.checked; saveExtraState(); }); }
    const limit = dialog.querySelector<HTMLInputElement>(".mle-media-limit");
    if (limit) { limit.value = String(mediaLimitMb); limit.addEventListener("change", () => { mediaLimitMb = Math.max(1, Math.min(2048, Number(limit.value) || 100)); saveExtraState(); void pruneMedia(); }); }
    const ignored = dialog.querySelector<HTMLInputElement>(".mle-ignored-users");
    if (ignored) { ignored.value = ignoredUsers; ignored.addEventListener("change", () => { ignoredUsers = ignored.value; saveExtraState(); }); }
    dialog.querySelector(".mle-pause")?.addEventListener("click", () => { paused = !paused; saveExtraState(); updatePanelState(); });
    dialog.querySelector(".mle-backup")?.addEventListener("click", makeBackup);
    const fileInput = dialog.querySelector<HTMLInputElement>(".mle-import-file");
    dialog.querySelector(".mle-restore")?.addEventListener("click", () => fileInput?.click());
    fileInput?.addEventListener("change", async () => {
        if (!fileInput.files?.[0]) return;
        try { await importBackup(fileInput.files[0]); alert("Backup restored. Existing logs were merged without duplicate keys."); }
        catch (error) { alert(`Backup import failed: ${String(error)}`); }
        fileInput.value = "";
    });
    dialog.querySelector(".mle-reset-filters")?.addEventListener("click", () => {
        filterAuthor = filterChannel = filterSince = filterUntil = "";
        for (const selector of [".mle-filter-author", ".mle-filter-channel", ".mle-filter-since", ".mle-filter-until"]) {
            const item = dialog.querySelector<HTMLInputElement>(selector); if (item) item.value = "";
        }
        dialogPage = 1; renderLogDialog();
    });
    updatePanelState();

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
        downloadJsonFile(getVisibleLogs()));
    dialog.querySelector(".mle-clear")?.addEventListener("click", () => {
        const label = dialogLogType === "deleted" ? "deleted-message" : dialogLogType === "edited" ? "edited-message" : "message";
        if (confirm(`Delete every saved ${label} log in this view? This cannot be undone.`))
            clearVisibleLogType();
    });

    dialog.querySelector<HTMLInputElement>(".mle-badge-setting")?.addEventListener("change", event => {
        settings.store.showUnreadBadge = (event.currentTarget as HTMLInputElement).checked;
        updateToolbarBadge();
    });

    const search = dialog.querySelector<HTMLInputElement>(".mle-search");
    const clearSearch = dialog.querySelector<HTMLButtonElement>(".mle-search-clear");
    let searchTimer: ReturnType<typeof setTimeout> | undefined;

    const updateClearSearchButton = () =>
        clearSearch?.classList.toggle("mle-visible", Boolean(search?.value));

    search?.addEventListener("input", () => {
        updateClearSearchButton();
        if (searchTimer)
            clearTimeout(searchTimer);

        searchTimer = setTimeout(() => {
            dialogSearch = search.value;
            dialogPage = 1;
            renderLogDialog();

            // Rendering only replaces the result list, but explicitly restore
            // focus and cursor position for custom Discord themes/plugins.
            search.focus();
            search.setSelectionRange(search.value.length, search.value.length);
        }, 90);
    });

    search?.addEventListener("keydown", event => {
        if (event.key === "Escape" && search.value) {
            event.preventDefault();
            search.value = "";
            dialogSearch = "";
            dialogPage = 1;
            updateClearSearchButton();
            renderLogDialog();
        }
    });

    clearSearch?.addEventListener("click", () => {
        if (!search) return;
        search.value = "";
        dialogSearch = "";
        dialogPage = 1;
        updateClearSearchButton();
        renderLogDialog();
        search.focus();
    });
    updateClearSearchButton();

    const logType = dialog.querySelector<HTMLSelectElement>(".mle-log-type");
    logType?.addEventListener("change", () => {
        const value = logType.value;
        dialogLogType = value === "deleted" || value === "edited" ? value : "all";
        dialogPage = 1;
        renderLogDialog();
    });

    const contentFilter = dialog.querySelector<HTMLSelectElement>(".mle-content-filter");
    contentFilter?.addEventListener("change", () => {
        const value = contentFilter.value;
        dialogContentFilter = value === "text" || value === "images" || value === "gifs"
            ? value
            : "all";
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
    const count = settings.store.showUnreadBadge
        ? logs.filter(log => Date.parse(log.loggedAt) > lastViewedAt).length
        : 0;
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
    const element = document.createElement("li");
    element.id = retainedElementId(message.channelId, message.messageId);
    element.className = "mle-retained-deleted-message";
    element.setAttribute("role", "listitem");
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

function extractMessageIdFromElement(element: Element): string | undefined {
    const id = element.id || element.getAttribute("data-list-item-id") || "";
    const match = id.match(/(\d{15,25})(?!.*\d)/);
    return match?.[1];
}

function findMessageContainer(element: Element | null | undefined): Element | null {
    if (!element) return null;

    return element.closest(
        'li[id^="chat-messages-"], li[data-list-item-id*="chat-messages"], [id^="chat-messages-"]'
    ) ?? element;
}

function insertRetainedChronologically(retained: HTMLElement, message: CachedMessage): boolean {
    const messageList = document.querySelector<HTMLElement>('[data-list-id="chat-messages"]');
    if (!messageList)
        return false;

    const candidates = Array.from(messageList.querySelectorAll<HTMLElement>(
        ':scope > li[id^="chat-messages-"], :scope > li[data-list-item-id*="chat-messages"], :scope > [id^="chat-messages-"]'
    ));

    if (!candidates.length)
        return false;

    let deletedId: bigint;
    try {
        deletedId = BigInt(message.messageId);
    } catch {
        return false;
    }

    for (const candidate of candidates) {
        const candidateIdText = extractMessageIdFromElement(candidate);
        if (!candidateIdText) continue;

        try {
            if (BigInt(candidateIdText) > deletedId) {
                messageList.insertBefore(retained, candidate);
                return true;
            }
        } catch { }
    }

    // Only append after the final real message element—not to an empty list or composer area.
    const lastRealMessage = candidates.at(-1);
    if (!lastRealMessage?.parentElement)
        return false;

    lastRealMessage.insertAdjacentElement("afterend", retained);
    return true;
}

function retainDeletedMessageInChat(message: CachedMessage, originalElement?: Element | null) {
    if (!settings.store.keepDeletedMessagesInChat)
        return;

    if (!shouldTrackLocation(message.channelId, message.guildId))
        return;

    // Never inject a deleted message into a different open channel.
    if (SelectedChannelStore.getChannelId() !== message.channelId)
        return;

    removeRetainedMessage(message.channelId, message.messageId);

    const retained = buildRetainedDeletedMessage(message);
    const key = cacheKey(message.channelId, message.messageId);
    const originalContainer = findMessageContainer(originalElement);
    const originalParent = originalContainer?.parentElement ?? null;
    const originalNextSibling = originalContainer?.nextSibling ?? null;
    let inserted = false;

    const insert = () => {
        if (inserted || document.getElementById(retained.id))
            return;

        if (SelectedChannelStore.getChannelId() !== message.channelId)
            return;

        // Preferred path: preserve the exact original position captured before Discord removes it.
        if (originalParent?.isConnected) {
            if (originalNextSibling && originalNextSibling.parentNode === originalParent)
                originalParent.insertBefore(retained, originalNextSibling);
            else if (originalContainer?.isConnected)
                originalContainer.insertAdjacentElement("afterend", retained);
            else
                return; // Do not append blindly when the exact anchor disappeared.

            inserted = true;
        } else {
            // Reopening/jumping to an old log: place it by Discord snowflake order.
            inserted = insertRetainedChronologically(retained, message);
        }

        if (inserted)
            retainedDeletedElements.set(key, retained);
    };

    // Discord removes the original React element shortly after the delete dispatch.
    setTimeout(insert, 35);
    setTimeout(insert, 180);
    setTimeout(insert, 450);
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
        .mle-live-edited-message { position:relative; }
        .mle-live-edited-message::after {
            content:attr(data-mle-edited);
            display:inline-block;
            margin-left:7px;
            padding:1px 6px;
            border-radius:4px;
            color:#1e1f22;
            background:#f0b232;
            font-size:10px;
            font-weight:800;
            vertical-align:middle;
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
    if (paused || !event.message || event.optimistic) return;
    const item = rememberMessage(event.message);
    if (item && !ignoredAuthor(item.author)) void cacheMedia(item.attachments);
}

function handleDelete(event: { channelId: string; id: string; }) {
    const channelId = String(event.channelId ?? "");
    const messageId = String(event.id ?? "");
    if (paused || !channelId || !messageId) return;

    const originalElement = document.getElementById(`chat-messages-${channelId}-${messageId}`)
        ?? document.querySelector(`[data-list-item-id*="${channelId}-${messageId}"]`);

    const message = removeCachedMessage(channelId, messageId);
    if (!message || shouldIgnore(message) || ignoredAuthor(message.author) || !shouldTrackLocation(channelId, message.guildId)) return;

    retainDeletedMessageInChat(message, originalElement);

    addLog({
        key: `deleted:${channelId}:${messageId}`,
        type: "deleted",
        ghostPing: isGhostPing(message),
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
    if (paused || !channelId || !messageId) return;

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
    void cacheMedia(updated.attachments);

    // Discord can emit partial MESSAGE_UPDATE events that do not contain content.
    // Only create an edit log when we know both the old and new text.
    if (!previous || incoming.content == null) return;

    const oldContent = previous.content;
    const newContent = String(incoming.content);
    if (oldContent === newContent || shouldIgnore(updated) || ignoredAuthor(updated.author)) return;

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

    // Add a visible marker to the live message without replacing Discord's message rendering.
    setTimeout(() => {
        if (SelectedChannelStore.getChannelId() !== channelId) return;
        const element = document.getElementById(`chat-messages-${channelId}-${messageId}`)
            ?? document.querySelector<HTMLElement>(`[data-list-item-id*="${channelId}-${messageId}"]`);
        if (!element) return;
        element.classList.add("mle-live-edited-message");
        element.setAttribute("data-mle-edited", "Edited");
    }, 80);
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
    showUnreadBadge: {
        type: OptionType.BOOLEAN,
        description: "Show the red notification number for new deleted or edited messages until the panel is opened",
        default: true,
        onChange: () => updateToolbarBadge()
    },
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

        const [storedLogs, storedCache, legacyLogs, legacyCache, storedLastViewed] = await Promise.all([
            DataStore.get<PersistentLog[]>(STORE_KEY),
            DataStore.get<Record<string, CachedMessage>>(CACHE_KEY),
            DataStore.get<PersistentLog[]>(LEGACY_STORE_KEY),
            DataStore.get<Record<string, CachedMessage>>(LEGACY_CACHE_KEY),
            DataStore.get<number>(READ_KEY)
        ]);
        const savedExtra = await DataStore.get<{paused?: boolean; ignoredUsers?: string; mediaCacheEnabled?: boolean; mediaLimitMb?: number}>(EXTRA_KEY);
        paused = !!savedExtra?.paused;
        ignoredUsers = String(savedExtra?.ignoredUsers ?? "");
        mediaCacheEnabled = !!savedExtra?.mediaCacheEnabled;
        mediaLimitMb = Math.max(1, Number(savedExtra?.mediaLimitMb) || 100);
        void refreshMediaSize();
        lastViewedAt = typeof storedLastViewed === "number" ? storedLastViewed : Date.now();
        if (typeof storedLastViewed !== "number") void DataStore.set(READ_KEY, lastViewedAt);

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
