type CompatMissingKind = 'get' | 'call' | 'construct';
type CompatWarning = (kind: CompatMissingKind, label: string) => void;
export declare function createCompatValueWrapper(onMissing: CompatWarning): <T>(value: T, label: string) => T;
export {};
