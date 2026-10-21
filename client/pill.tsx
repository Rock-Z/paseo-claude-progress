import type { PluginButtonContentProps, PluginButtonIconProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import {
  type ReactElement,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  type ScrollView as NativeScrollView,
  Platform,
  Pressable,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import type { Round, Update } from "../shared/rpc";
import { fitPill, widenPopover } from "./web";

export interface Progress {
  running: boolean;
  steps: readonly Update[];
  recap: Update | null;
  rounds: readonly Round[];
}

// Claude Code's spinner glyphs, forward then back, one frame every 120 ms. ✳ is also an emoji, which
// iOS draws by default; U+FE0E asks for the plain text glyph.
const STAR = "✳\uFE0E";
const FRAMES = ["·", "✢", STAR, "✶", "✻", "✽", "✽", "✻", "✶", STAR, "✢", "·"];

// The pill's label size on a tight line, so wrapped updates stay compact; times a size smaller.
const FONT_SIZE = 12;
const LINE_HEIGHT = 16;
const TIME_SIZE = 10;
// Leaves Paseo's popover (at most 440 px tall) room for its padding, so only this list scrolls.
const LIST_MAX_HEIGHT = 380;
// How far a swipe can pull a turn sideways in the phone sheet; past half of it, the swipe flips.
const SWIPE = 64;
// Puts the turn counter on the sheet's title line. Paseo leaves 12 px under the title, 4 px of page
// padding and 12 px of content padding, and the panel pulls up 6 px: the title line's centre (14 px
// text, about 17 px tall) is 30.5 px above the panel, and the counter's 16 px line centres on it.
const TITLE_LINE_TOP = -38;

// Each agent's progress as the composer last saw it, so its popover opens filled and stays live.
const progress = new Map<string, Progress>();
const listeners = new Set<() => void>();
// Where each agent's list was left, and how many updates it showed then.
const scrollMemory = new Map<string, { offset: number; seen: number }>();

export function publish(agentId: string, value: Progress) {
  progress.set(agentId, value);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Marks are set at the pill's label size, so they sit on the text's baseline like Claude Code's.
function Spinner({ color, lineHeight }: { color: string; lineHeight?: number }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame((current) => (current + 1) % FRAMES.length), 120);
    return () => clearInterval(timer);
  }, []);
  return <Text style={{ color, fontSize: FONT_SIZE, lineHeight }}>{FRAMES[frame]}</Text>;
}

// The spinner keeps an 11 px slot, the widest of its glyphs, so the label doesn't shift between frames.
export function StepIcon({ color }: PluginButtonIconProps) {
  return (
    <View ref={(node) => fitPill(node, "11px")}>
      <Spinner color={color} />
    </View>
  );
}

// No mark while Claude isn't working, so the text gets the room.
export function QuietIcon() {
  return <View ref={(node) => fitPill(node, null)} />;
}

export function ProgressPanel({ theme, ...target }: PluginButtonContentProps) {
  const agentId = target.context === "agent" ? target.agentId : "";
  const state = useSyncExternalStore(subscribe, () => progress.get(agentId));
  const count = (state?.steps.length ?? 0) + (state?.recap ? 1 : 0);
  const list = useRef<NativeScrollView>(null);
  // Reopen where the list was left, unless updates arrived since: then show the latest, at the bottom.
  const pending = useRef<number | "end" | null>(reopenAt(agentId, count));
  const offset = useRef(typeof pending.current === "number" ? pending.current : 0);
  const shown = useRef(count);
  useLayoutEffect(() => {
    if (count > shown.current) pending.current = "end";
    shown.current = count;
  }, [count]);
  useEffect(
    () => () => {
      scrollMemory.set(agentId, { offset: offset.current, seen: shown.current });
    },
    [agentId],
  );
  const settle = () => {
    if (pending.current === "end") list.current?.scrollToEnd({ animated: false });
    else if (pending.current !== null) list.current?.scrollTo({ y: pending.current, animated: false });
    pending.current = null;
  };
  const [page, setPage] = useState<number | null>(null);
  const pager = useRef<NativeScrollView>(null);
  // The pager's width, guessed from the window (the sheet's 12 px padding, less the 4 px pull-left)
  // until it is measured, so the first frame doesn't lay the text out on one line.
  const windowWidth = useWindowDimensions().width;
  const [width, setWidth] = useState<number | null>(null);
  if (!state) return null;
  const muted = theme.colors.foregroundMuted;
  // The round on show: one picked with the arrows, or the latest (null), which stays live.
  const latest = state.rounds.length;
  const index = page ?? latest;
  const round = index < latest ? { ...state.rounds[index], running: false } : state;
  const flip = (to: number) => {
    pending.current = "end";
    setPage(to < latest ? to : null);
  };
  // Paseo shows the panel in a bottom sheet on narrow screens, titled with the pill's title.
  const sheet = target.layout.compact;
  // The phone app flips turns with a sideways swipe. Web reports no end of a drag, so it keeps arrows.
  const swipes = latest > 0 && sheet && Platform.OS !== "web";
  // The arrows sit at the last row's bottom right, so its text wraps beside them instead of above a line of their own.
  const arrows = latest && !swipes ? (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
      {sheet ? null : (
        <Text style={{ color: muted, fontSize: TIME_SIZE, lineHeight: LINE_HEIGHT }}>
          {index + 1}/{latest + 1}
        </Text>
      )}
      <Arrow label="Earlier round" color={muted} disabled={index === 0} onPress={() => flip(index - 1)}>
        ‹
      </Arrow>
      <Arrow label="Later round" color={muted} disabled={index === latest} onPress={() => flip(index + 1)}>
        ›
      </Arrow>
    </View>
  ) : null;
  const rows = (
    <>
      {round.steps.map((step, index) => {
        const current = round.running && index === round.steps.length - 1;
        const color = current ? theme.colors.foreground : muted;
        return (
          <Row
            key={index}
            mark={current ? <Spinner color={color} lineHeight={LINE_HEIGHT} /> : <Mark color={color}>-</Mark>}
            at={step.at}
            muted={muted}
            trailer={!round.recap && index === round.steps.length - 1 ? arrows : null}
          >
            <Text style={{ color }}>{step.text}</Text>
          </Row>
        );
      })}
      {round.recap ? (
        <>
          {round.steps.length ? (
            <View style={{ height: 1, marginVertical: 4, backgroundColor: theme.colors.border }} />
          ) : null}
          {/* Claude Code prints a recap as a bold "recap:" and the recap in italics, all dimmed. */}
          <Row mark={<Mark color={muted}>※</Mark>} at={round.recap.at} muted={muted} trailer={arrows}>
            <Text style={{ color: muted }}>
              <Text style={{ fontWeight: "600" }}>recap: </Text>
              <Text style={{ fontStyle: "italic" }}>{round.recap.text}</Text>
            </Text>
          </Row>
        </>
      ) : null}
    </>
  );
  return (
    // Paseo pads the popover 12 px plus 4 px more vertically, each row adds 2 px, and the last line
    // keeps its descender space: these margins put the text's ink about 12 px from every edge.
    <View ref={widenPopover} style={{ marginTop: -6, marginBottom: -8, marginLeft: -4 }}>
      {latest && sheet ? (
        <Text
          style={{
            position: "absolute",
            top: TITLE_LINE_TOP,
            right: 0,
            color: muted,
            fontSize: TIME_SIZE,
            lineHeight: LINE_HEIGHT,
          }}
        >
          Turn {index + 1} of {latest + 1}
        </Text>
      ) : null}
      {/* On phones Paseo shows this in a bottom sheet that scrolls itself and sizes to what its
          scroll view reports. A second scroll view would report only these rows, and the sheet
          would shrink to them; so only web keeps its own list, which remembers where it was left. */}
      {Platform.OS === "web" ? (
        <ScrollView
          ref={list}
          style={{ maxHeight: LIST_MAX_HEIGHT }}
          onContentSizeChange={settle}
          onScroll={(event) => {
            offset.current = event.nativeEvent.contentOffset.y;
          }}
          scrollEventThrottle={16}
        >
          {rows}
        </ScrollView>
      ) : swipes ? (
        // The turn sits in a strip 2 × SWIPE wider than itself, scrolled to the middle: a swipe
        // pulls it aside, and letting go past half the slack flips the turn; either way it springs back.
        <ScrollView
          ref={pager}
          horizontal
          showsHorizontalScrollIndicator={false}
          contentOffset={{ x: SWIPE, y: 0 }}
          onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
          onContentSizeChange={() => pager.current?.scrollTo({ x: SWIPE, animated: false })}
          onScrollEndDrag={(event) => {
            const pulled = event.nativeEvent.contentOffset.x - SWIPE;
            const to = pulled > 0 ? index + 1 : index - 1;
            if (Math.abs(pulled) > SWIPE / 2 && to >= 0 && to <= latest) flip(to);
            pager.current?.scrollTo({ x: SWIPE, animated: true });
          }}
        >
          <View style={{ width: width ?? windowWidth - 20, marginHorizontal: SWIPE }}>{rows}</View>
        </ScrollView>
      ) : (
        rows
      )}
      {/* A turn that has just started may have no rows yet to hold the arrows. */}
      {round.steps.length || round.recap ? null : <View style={{ alignItems: "flex-end" }}>{arrows}</View>}
    </View>
  );
}

// Flips between the session's rounds; dimmed at either end.
function Arrow(props: { label: string; color: string; disabled: boolean; onPress: () => void; children: string }) {
  return (
    <Pressable accessibilityLabel={props.label} disabled={props.disabled} onPress={props.onPress} hitSlop={8}>
      <Text style={{ color: props.color, opacity: props.disabled ? 0.35 : 1, fontSize: 20, lineHeight: LINE_HEIGHT }}>
        {props.children}
      </Text>
    </Pressable>
  );
}

function reopenAt(agentId: string, count: number) {
  const memory = scrollMemory.get(agentId);
  return memory && count <= memory.seen ? memory.offset : "end";
}

function Mark({ color, children }: { color: string; children: string }) {
  return <Text style={{ color, fontSize: FONT_SIZE, lineHeight: LINE_HEIGHT }}>{children}</Text>;
}

// One line per update, set like the pill's label: mark, text wrapping tightly, time on the right
// and an optional trailer at the bottom right, beside the text's last line.
function Row(props: { mark: ReactNode; at: string; muted: string; trailer?: ReactNode; children: ReactElement }) {
  const { mark, at, muted, trailer, children } = props;
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 6, paddingVertical: 2 }}>
      <View style={{ width: 11, height: LINE_HEIGHT, alignItems: "center", justifyContent: "center" }}>
        {mark}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: FONT_SIZE, lineHeight: LINE_HEIGHT }}>{children}</Text>
      </View>
      <View style={{ alignSelf: "stretch", alignItems: "flex-end", justifyContent: "space-between" }}>
        <Text style={{ color: muted, fontSize: TIME_SIZE, lineHeight: LINE_HEIGHT }}>
          {new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
        </Text>
        {trailer}
      </View>
    </View>
  );
}
