import { logger } from '../lib/winston-common.js';
import { encode, decode } from 'msgpack-lite';
import type { JsonValue } from 'type-fest';
import WebSocket from 'ws';

export default class EventWebSocket {
    socket: WebSocket;
    url: string;
    callbacks: Record<string, { callback: Function; once: boolean }[]> = {};
    retryTimer?: NodeJS.Timer;

    get readyState() {
        // 3 is closed
        return this.socket.readyState;
    }

    get connected() {
        return this.readyState === 1;
    }

    initSocket() {
        this.socket.onmessage = (rawEv) => {
            logger.verbose('WebSocket onMessage.');

            const payload = decode(rawEv.data as Buffer) as [string, JsonValue];
            logger.silly(rawEv.data);
            this.dispatchEvent(payload[0], payload[1]);
        };

        this.socket.onopen = () => {
            logger.verbose('WebSocket opened.');
            if (this.retryTimer) {
                clearInterval(this.retryTimer);
                this.retryTimer = undefined;
            }
            this.dispatchEvent('open', undefined);
        };

        this.socket.onclose = () => {
            logger.verbose('WebSocket closed.');
            this.retryTimer = setInterval(() => this.reconnect(), 1000);

            this.dispatchEvent('close', undefined);
        };

        this.socket.onerror = (e) => {
            logger.verbose('WebSocket errored: ', e.message);
            this.dispatchEvent('error', undefined);
        };
    }

    constructor(socketUrl: string) {
        this.url = socketUrl;
        this.socket = new WebSocket(socketUrl);
        this.initSocket();
    }

    connect() {
        return new Promise((res) => {
            while (!this.connected);

            res(undefined);
        });
    }

    reconnect() {
        // connection closed
        if (this.readyState === 3) {
            this.socket = new WebSocket(this.url);
            this.initSocket();
        }
    }

    on(event: string, cb: Function): this {
        this.callbacks[event] = this.callbacks[event] || [];
        this.callbacks[event].push({ callback: cb, once: false });
        return this;
    }

    off(event: string): this {
        this.callbacks[event] = [];
        return this;
    }

    once(event: string, cb: Function): this {
        this.callbacks[event] = this.callbacks[event] || [];
        this.callbacks[event].push({ callback: cb, once: true });
        return this;
    }

    emit(event: string, payload: JsonValue): this {
        this.socket.send(encode([event, payload]));
        return this;
    }

    dispatchEvent(event: string, payload: JsonValue) {
        if (this.callbacks[event]) {
            for (const cb of this.callbacks[event]) {
                cb.callback(payload);
            }
            this.callbacks[event] = this.callbacks[event].filter(
                (cb) => !cb.once,
            );
        }
    }

    close() {
        this.socket.close();
    }
}
