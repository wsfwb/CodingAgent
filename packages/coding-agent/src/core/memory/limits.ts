export const MEMORY_LIMITS = {
	topicSoftBytes: 16 * 1024,
	topicHardBytes: 24 * 1024,
	topicTargetBytes: 12 * 1024,
	indexSoftBytes: 20 * 1024,
	indexHardBytes: 25 * 1024,
	indexTargetBytes: 16 * 1024,
	keyChars: 64,
	titleChars: 120,
	summaryChars: 256,
	contentBytes: 4 * 1024,
} as const;

export function utf8Bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}
