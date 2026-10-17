import type { QuatiState } from "@/lib/mascot";

export interface SceneProps {
  playing: boolean;
  onCue?: (state: QuatiState) => void;
  onEnded?: () => void;
  label: string;
}
