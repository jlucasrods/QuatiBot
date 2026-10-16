import { useEffect, useRef, useState } from "react";
type ModifierEvent = Pick<KeyboardEvent, "altKey" | "ctrlKey" | "code" | "repeat">;
export function isPushToTalkPress(event: ModifierEvent): boolean {
    const modifier = event.code === "AltLeft" ||
        event.code === "AltRight" ||
        event.code === "ControlLeft" ||
        event.code === "ControlRight";
    return modifier && event.altKey && event.ctrlKey && !event.repeat;
}
export function usePushToTalk(targetId: string, enabled: boolean, onError: () => void): boolean {
    const [active, setActive] = useState(false);
    const held = useRef(false);
    const enabledRef = useRef(enabled);
    const onErrorRef = useRef(onError);
    enabledRef.current = enabled;
    onErrorRef.current = onError;
    useEffect(() => {
        if (enabled)
            return;
        held.current = false;
        setActive(false);
    }, [enabled]);
    useEffect(() => {
        return;
    }, [targetId]);
    return active;
}
