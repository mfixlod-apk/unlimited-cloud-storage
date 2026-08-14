export type Theme = "light" | "dark";

export const friendlyError = (error: unknown) => {
  const raw = error instanceof Error ? error.message : String(error);
  const code = raw.toUpperCase();
  if (code.includes("API_ID_INVALID")) return "That API ID and API hash do not match. Check them and try again.";
  if (code.includes("PHONE_NUMBER_INVALID")) return "Enter a valid phone number including the country code.";
  if (code.includes("PHONE_CODE_INVALID")) return "That login code is not correct. Try again.";
  if (code.includes("PHONE_CODE_EXPIRED")) return "That login code expired. Start the phone login again.";
  if (code.includes("PASSWORD_HASH_INVALID")) return "That two-step verification password is not correct.";
  if (code.includes("CHANNELS_TOO_MUCH")) return "This Telegram account has reached its channel limit.";
  if (code.includes("CHAT_TITLE_EMPTY")) return "Enter a name for the storage channel.";
  if (code.includes("FLOOD_WAIT")) return "Telegram asked this device to slow down. Wait a little, then try again.";
  if (code.includes("NETWORK") || code.includes("WEBSOCKET") || code.includes("CONNECTION")) return "Could not reach Telegram. Check your connection or network restrictions.";
  if (code.includes("ABORT")) return "The operation was cancelled.";
  return raw.length < 180 ? raw : "Something went wrong while talking to Telegram. Please try again.";
};

export const formatSize = (bytes: number) => {
  if (!bytes) return "Unknown size";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value.toFixed(index > 1 && value < 10 ? 1 : 0)} ${units[index]}`;
};

export const formatDate = (date: Date) => new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
}).format(date);

export const userName = (user: any) => [user?.firstName, user?.lastName].filter(Boolean).join(" ") || user?.username || "Telegram user";
