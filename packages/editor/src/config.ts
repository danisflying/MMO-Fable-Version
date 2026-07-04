import { SERVER_PORT } from "@mmo/shared";

const host = location.hostname || "localhost";

export const WS_URL = `ws://${host}:${SERVER_PORT}`;
export const ASSETS_URL = `http://${host}:${SERVER_PORT}/assets`;
