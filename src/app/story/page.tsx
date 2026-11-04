import type { Metadata } from "next";
import { demoControlsAllowed } from "@/lib/demo";
import { metaAvailable } from "@/lib/meta";
import { StoryPlayer } from "./player";

export const metadata: Metadata = { title: "Guided story" };

// A guided, self-playing walkthrough: Ana (buyer) and Bo (stockist) side by
// side, the real app in each pane, driven step by step with captions. Every
// step is a real action in the app; nothing on screen is staged.

export default function StoryPage() {
  return <StoryPlayer meta={metaAvailable()} resets={demoControlsAllowed()} />;
}
