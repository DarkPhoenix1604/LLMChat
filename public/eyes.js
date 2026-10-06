// Recall's animated eyes for voice conversation mode: white rounded-rectangle eyes with pupils on
// a black screen, like a desk robot's face. Everything is procedural and modelled on how people
// use their eyes in conversation:
//
// - Blinks close in ~80 ms, stay shut ~60 ms and open in ~150 ms. They come every 2-6 s at rest,
//   more often while speaking, are held back while the user is talking, and land at the end of
//   the user's sentence and at Recall's phrase boundaries.
// - Gaze jumps between fixations in quick saccades, with small micro-saccades in between.
// - Gaze aversion: look up and away while thinking, glance away when starting a reply and now and
//   then mid-reply, look back at the user to hand the turn over, and break eye contact briefly
//   after 3-5 s of mutual gaze.
// - Expressions come from Cozmo-style eyelids and eye shapes: narrowed when thinking, wide when
//   listening, a raised lower lid when happy, drooping outer lids when sad, a head tilt when curious.
// - "Tone": the eyes widen with the user's voice and nod at their pauses, tilt at questions, take on
//   the mood of Recall's reply and bounce with its voice.
// - Pet behaviour: pupils follow the pointer, a click boops (and wakes) Recall, a double-click
//   toggles the big view, and the eyes get sleepy and fall asleep when nobody talks for a while.

const EXPRESSIONS = {
	// w, h: eye size; upper, lower: eyelid coverage (0-1); slant: upper-lid tilt, + droops the outer
	// corners (sad); tilt: face rotation in radians; pupil: pupil size; asym: one eye bigger (curious)
	neutral: { w: 1, h: 1, upper: 0, lower: 0, slant: 0, tilt: 0, pupil: 1, asym: 0 },
	listening: { w: 1, h: 1.06, upper: 0, lower: 0, slant: 0, tilt: 0, pupil: 1.06, asym: 0 },
	thinking: { w: 1, h: 0.94, upper: 0.3, lower: 0.08, slant: 0, tilt: 0.03, pupil: 0.95, asym: 0 },
	curious: { w: 1, h: 1.06, upper: 0.04, lower: 0, slant: 0, tilt: 0.1, pupil: 1.1, asym: 0.12 },
	happy: { w: 1.04, h: 1, upper: 0.04, lower: 0.42, slant: 0, tilt: 0, pupil: 1, asym: 0 },
	excited: { w: 1.08, h: 1.1, upper: 0, lower: 0.3, slant: 0, tilt: 0, pupil: 1.12, asym: 0 },
	surprised: { w: 1.12, h: 1.16, upper: 0, lower: 0, slant: 0, tilt: 0, pupil: 0.72, asym: 0 },
	sad: { w: 0.98, h: 0.94, upper: 0.28, lower: 0, slant: 0.55, tilt: -0.03, pupil: 1, asym: 0 },
	sleepy: { w: 1.02, h: 0.92, upper: 0.58, lower: 0.06, slant: 0.18, tilt: 0, pupil: 1, asym: 0 },
	asleep: { w: 1.04, h: 0.9, upper: 1, lower: 0, slant: 0, tilt: 0, pupil: 1, asym: 0 },
};
const MOODS = new Set(["happy", "excited", "curious", "thinking", "sad", "surprised", "neutral"]);

const BLINK_CLOSE_MS = 80;
const BLINK_HOLD_MS = 60;
const BLINK_OPEN_MS = 150;
const SACCADE_MS = 45; // time constant for gaze jumps; saccades are fast and ballistic
const POINTER_HOLD_MS = 2000; // pupils follow the pointer this long after it last moved
const WANDER_AFTER_MS = 8000; // nobody talking: start looking around
const SLEEPY_AFTER_MS = 40000;
const ASLEEP_AFTER_MS = 75000;

const LAUGH = /\b(?:ha){2,}\b|\bhehe\b|\blol\b/i;

const rand = (min, max) => min + Math.random() * (max - min);
const chance = (p) => Math.random() < p;
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

export function createEyes(canvas, { onDoubleClick } = {}) {
	const ctx = canvas.getContext("2d");
	const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

	let running = false;
	let frame = 0;
	let lastFrame = 0;
	let state = "off";
	let idleSince = 0; // start of the current stretch of silence, for wandering and sleep

	const cur = { ...EXPRESSIONS.neutral }; // smoothed expression
	let mood = null; // expression for Recall's current reply
	let moodUntil = 0;
	let flash = null; // short-lived expression (boop, surprise)
	let flashUntil = 0;
	let question = false; // the user just asked something

	const gaze = { x: 0, y: 0 }; // where the eyes point now, -1..1
	let fixation = { x: 0, y: 0.05 }; // where they want to look
	let micro = { x: 0, y: 0 };
	let nextMicro = 0;
	let nextShift = 0;
	let nextAversion = 0;
	let returnAt = 0; // when an aversion ends and the eyes come back to the user
	let thinkSide = 1;
	let pointer = { x: 0, y: 0 };
	let pointerAt = -Infinity;

	let blinkStart = -Infinity;
	let blinkSlowness = 1;
	let nextBlink = 0;
	let secondBlinkAt = 0;
	let motions = []; // one-shot face motions: { kind, start, ms }
	let lastNod = 0;
	let inLevel = 0;
	let outLevel = 0;

	const resize = new ResizeObserver(() => {
		const dpr = window.devicePixelRatio || 1;
		canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
		canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
	});

	// --- Gaze and blink behaviour -------------------------------------------------------------

	function lookAtUser() {
		fixation = { x: 0, y: 0.05 };
	}

	/** Look away for a moment, then come back to the user. */
	function avert(now, ms, { up = false } = {}) {
		const side = chance(0.5) ? -1 : 1;
		fixation = up ? { x: side * rand(0.4, 0.7), y: rand(-0.75, -0.45) } : { x: side * rand(0.45, 0.75), y: rand(-0.1, 0.3) };
		returnAt = now + ms;
		if (chance(0.3)) blink(now); // big gaze shifts often come with a blink
	}

	function blink(now, slowness = 1) {
		if (now - blinkStart < (BLINK_CLOSE_MS + BLINK_HOLD_MS + BLINK_OPEN_MS) * blinkSlowness) return;
		blinkStart = now;
		blinkSlowness = slowness;
		secondBlinkAt = chance(0.15) ? now + 330 * slowness : 0; // the occasional double blink
		nextBlink = now + blinkInterval();
	}

	function blinkInterval() {
		if (state === "speaking") return rand(1500, 3500); // speakers blink more
		if (state === "hearing") return rand(5000, 9000); // listeners hold blinks while taking things in
		if (state === "thinking") return rand(2500, 5000);
		return rand(2000, 6000);
	}

	/** How closed the eyes are from blinking, 0-1. */
	function blinkAmount(now) {
		const t = (now - blinkStart) / blinkSlowness;
		if (t < 0) return 0;
		if (t < BLINK_CLOSE_MS) return easeIn(t / BLINK_CLOSE_MS);
		if (t < BLINK_CLOSE_MS + BLINK_HOLD_MS) return 1;
		const open = (t - BLINK_CLOSE_MS - BLINK_HOLD_MS) / BLINK_OPEN_MS;
		return open < 1 ? 1 - easeOut(open) : 0;
	}

	function move(kind, ms, now = performance.now()) {
		if (reduceMotion) return;
		motions.push({ kind, start: now, ms });
	}

	function flashExpression(name, ms, now = performance.now()) {
		flash = name;
		flashUntil = now + ms;
	}

	function idleFor(now) {
		return state === "listening" ? now - idleSince : 0;
	}

	function behave(now) {
		const idle = idleFor(now);
		if (returnAt && now >= returnAt) {
			returnAt = 0;
			lookAtUser();
			nextAversion = now + rand(3000, 5000); // mutual gaze gets uncomfortable after 3-5 s
		}

		if (state === "listening" && idle > WANDER_AFTER_MS) {
			// Nobody is talking: look around the room.
			if (now >= nextShift) {
				fixation = { x: rand(-0.8, 0.8), y: rand(-0.5, 0.4) };
				nextShift = now + rand(1500, 4000);
				if (chance(0.3)) blink(now);
			}
		} else if (state === "thinking") {
			// Look up and away while working out an answer, sometimes searching to the other side.
			if (now >= nextShift) {
				fixation = { x: thinkSide * rand(0.4, 0.75), y: rand(-0.8, -0.5) };
				if (chance(0.4)) thinkSide *= -1;
				nextShift = now + rand(1200, 2400);
			}
		} else if ((state === "listening" || state === "speaking") && !returnAt && now >= nextAversion) {
			avert(now, rand(450, 900));
		}

		if (now >= nextMicro) {
			micro = { x: rand(-0.05, 0.05), y: rand(-0.04, 0.04) };
			nextMicro = now + rand(300, 1100);
		}
		if (idle < ASLEEP_AFTER_MS) {
			if (now >= nextBlink) {
				nextBlink = now + blinkInterval(); // rescheduled even if a blink is already under way
				blink(now, idle > SLEEPY_AFTER_MS ? 2.5 : 1); // sleepy blinks are slow
			}
			if (secondBlinkAt && now >= secondBlinkAt) {
				secondBlinkAt = 0;
				blinkStart = now;
			}
		}
	}

	function expression(now) {
		if (flash && now < flashUntil) return flash;
		const idle = idleFor(now);
		switch (state) {
			case "listening":
				if (idle > ASLEEP_AFTER_MS) return "asleep";
				if (idle > SLEEPY_AFTER_MS) return "sleepy";
				return mood && now < moodUntil ? mood : "listening";
			case "hearing":
				return "listening";
			case "thinking":
				return question ? "curious" : "thinking";
			case "speaking":
				return mood ?? "neutral";
			default:
				return "neutral";
		}
	}

	// --- Public API -----------------------------------------------------------------------------

	function setState(next) {
		if (next === state) return;
		const now = performance.now();
		const prev = state;
		state = next;
		idleSince = now;
		returnAt = 0;
		switch (next) {
			case "listening":
				lookAtUser();
				nextAversion = now + rand(3000, 5000);
				if (prev === "speaking") blink(now);
				break;
			case "hearing":
				lookAtUser();
				nextBlink = now + blinkInterval();
				break;
			case "thinking":
				// Listeners blink when the speaker finishes, then look away to think.
				blink(now);
				thinkSide = chance(0.5) ? -1 : 1;
				nextShift = now + 180;
				break;
			case "speaking":
				// Speakers often look away as they start talking, then come back to the listener.
				avert(now, rand(500, 900), { up: chance(0.4) });
				break;
		}
	}

	/** Audio level (RMS) of the user's voice ("in") or Recall's ("out"). */
	function setLevel(level, source) {
		const v = clamp(level * 8, 0, 1);
		if (source === "in") {
			inLevel += (v - inLevel) * 0.5;
			if (v > 0.15) idleSince = performance.now();
		} else {
			// Fast attack, slower release, so the bounce follows syllables without jitter.
			outLevel += (v - outLevel) * (v > outLevel ? 0.6 : 0.15);
		}
	}

	function cue(name, detail) {
		const now = performance.now();
		switch (name) {
			case "speech-start":
				if (idleFor(now) > SLEEPY_AFTER_MS) flashExpression("surprised", 600, now); // woken up
				break;
			case "pause": // the user paused mid-thought: a small nod, like a listener's "mm-hm"
				if (now - lastNod > 2500) {
					lastNod = now;
					move("nod", 380, now);
					if (chance(0.5)) blink(now);
				}
				break;
			case "barge-in":
				flashExpression("surprised", 450, now);
				blink(now);
				break;
			case "question":
				question = true;
				break;
			case "confused": // heard something but couldn't make out words
				move("shake", 650, now);
				flashExpression("curious", 900, now);
				break;
			case "mood":
				if (MOODS.has(detail)) mood = detail;
				break;
			case "phrase": {
				// Recall started speaking a new chunk of its reply.
				const { index, text } = detail;
				if (index === 0 && !mood) mood = inferMood(text);
				if (LAUGH.test(text)) move("laugh", 700, now);
				if (index > 0) {
					if (chance(0.5)) blink(now);
					if (!returnAt && chance(0.3)) avert(now, rand(400, 700));
				}
				break;
			}
			case "reply-end":
				question = false;
				moodUntil = now + 1500; // let the mood linger for a moment
				lookAtUser();
				blink(now);
				break;
		}
	}

	function onPointerMove(e) {
		const rect = canvas.getBoundingClientRect();
		if (!rect.width) return;
		// Saturating map, so the eyes still track a pointer anywhere on the page.
		pointer = {
			x: Math.tanh(((e.clientX - (rect.left + rect.width / 2)) / rect.width) * 1.6),
			y: Math.tanh(((e.clientY - (rect.top + rect.height / 2)) / rect.height) * 1.2),
		};
		pointerAt = performance.now();
		if (idleFor(pointerAt) < SLEEPY_AFTER_MS) idleSince = Math.max(idleSince, pointerAt - WANDER_AFTER_MS / 2);
	}

	function onClick() {
		const now = performance.now();
		if (idleFor(now) > SLEEPY_AFTER_MS) {
			idleSince = now;
			flashExpression("surprised", 700, now);
		} else {
			flashExpression("happy", 900, now);
			move("laugh", 500, now);
		}
		blink(now);
	}

	function onEnter() {
		if (idleFor(performance.now()) < SLEEPY_AFTER_MS) flashExpression("happy", 800);
	}

	function onDblClick() {
		onDoubleClick?.();
	}

	function start() {
		if (running) return;
		running = true;
		const now = performance.now();
		state = "off";
		mood = null;
		flash = null;
		question = false;
		motions = [];
		idleSince = now;
		nextBlink = now + rand(800, 2000);
		Object.assign(cur, EXPRESSIONS.neutral);
		resize.observe(canvas);
		window.addEventListener("pointermove", onPointerMove);
		canvas.addEventListener("click", onClick);
		canvas.addEventListener("dblclick", onDblClick);
		canvas.addEventListener("pointerenter", onEnter);
		lastFrame = now;
		frame = requestAnimationFrame(tick);
	}

	function stop() {
		running = false;
		cancelAnimationFrame(frame);
		resize.disconnect();
		window.removeEventListener("pointermove", onPointerMove);
		canvas.removeEventListener("click", onClick);
		canvas.removeEventListener("dblclick", onDblClick);
		canvas.removeEventListener("pointerenter", onEnter);
	}

	// --- Animation and drawing ------------------------------------------------------------------

	function tick(now) {
		if (!running) return;
		const dt = Math.min(64, now - lastFrame);
		lastFrame = now;
		behave(now);

		// Ease the expression toward its target. Falling asleep is slow; everything else is snappy.
		const name = expression(now);
		const target = EXPRESSIONS[name];
		const ease = 1 - Math.exp(-dt / (name === "sleepy" || name === "asleep" ? 900 : 110));
		for (const k in target) cur[k] += (target[k] - cur[k]) * ease;

		// Saccade toward the pointer (if it moved recently) or the behavioural fixation.
		const pointerActive = now - pointerAt < POINTER_HOLD_MS && name !== "asleep";
		const goal = pointerActive ? pointer : { x: fixation.x + micro.x, y: fixation.y + micro.y };
		const jump = 1 - Math.exp(-dt / SACCADE_MS);
		gaze.x += (clamp(goal.x, -1, 1) - gaze.x) * jump;
		gaze.y += (clamp(goal.y, -1, 1) - gaze.y) * jump;

		if (state !== "speaking") outLevel *= 0.85;
		if (state !== "hearing" && state !== "listening") inLevel *= 0.85;

		draw(now);
		frame = requestAnimationFrame(tick);
	}

	function draw(now) {
		const dpr = canvas.width / Math.max(1, canvas.clientWidth);
		const W = canvas.clientWidth;
		const H = canvas.clientHeight;
		if (!W || !H) return;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.fillStyle = "#000";
		ctx.fillRect(0, 0, W, H);

		// Whole-face motion: nods, laughs, shakes, bouncing with Recall's voice, breathing in sleep.
		let dx = 0;
		let dy = 0;
		motions = motions.filter((m) => now - m.start < m.ms);
		for (const m of motions) {
			const t = (now - m.start) / m.ms;
			if (m.kind === "nod") dy += Math.sin(Math.PI * t) * H * 0.06;
			if (m.kind === "laugh") dy += Math.sin(t * Math.PI * 6) * H * 0.035 * (1 - t);
			if (m.kind === "shake") dx += Math.sin(t * Math.PI * 6) * W * 0.03 * (1 - t);
		}
		if (!reduceMotion) {
			dy -= outLevel * H * 0.035;
			if (cur.upper > 0.9) dy += Math.sin(now / 1400) * H * 0.015;
		}

		const blinkAmt = blinkAmount(now);
		const baseW = W * 0.25;
		const baseH = H * 0.74;
		const spacing = W * 0.35;

		ctx.save();
		ctx.translate(W / 2 + dx, H / 2 + dy);
		ctx.rotate(cur.tilt);
		for (const side of [-1, 1]) {
			// The eye on the side being looked at grows a little ("curiosity"), as if turning to look.
			const curiosity = 1 + 0.14 * Math.max(0, gaze.x * side);
			const w = baseW * cur.w * (1 + 0.05 * blinkAmt);
			const h =
				baseH *
				cur.h *
				curiosity *
				(1 + cur.asym * side) *
				(1 + 0.07 * inLevel + 0.06 * outLevel) *
				(1 - 0.9 * blinkAmt);
			const cx = (side * spacing) / 2 + gaze.x * W * 0.07;
			const cy = gaze.y * H * 0.08;
			if (cur.upper > 0.9) drawClosedEye(cx, cy, w, H);
			else drawEye(cx, cy, w, h, side);
		}
		ctx.restore();

		if (cur.upper > 0.9) drawZs(now, W, H);
	}

	function drawEye(cx, cy, w, h, side) {
		const x = cx - w / 2;
		const y = cy - h / 2;
		ctx.save();
		ctx.beginPath();
		roundRect(ctx, x, y, w, h, Math.min(w, h) * 0.22);
		ctx.shadowColor = "rgba(255, 255, 255, 0.35)";
		ctx.shadowBlur = h * 0.12;
		ctx.fillStyle = "#fff";
		ctx.fill();
		ctx.shadowBlur = 0;
		ctx.clip();

		// Pupil, offset toward where the eye is looking. It moves up out of the way of a rising lower
		// lid and disappears into a happy "^" eye, which otherwise turns into a keyhole shape.
		const shown = 1 - smoothstep(0.3, 0.4, cur.lower);
		const pw = (w / 3) * cur.pupil * (1 + 0.1 * inLevel) * shown;
		const ph = (h / 3) * cur.pupil * (1 + 0.1 * inLevel) * shown;
		const px = cx + gaze.x * w * 0.22 - pw / 2;
		const py = cy + gaze.y * h * 0.22 - ph / 2 - cur.lower * h * 0.3;
		ctx.fillStyle = "#000";
		if (pw > 0.5) {
			ctx.beginPath();
			roundRect(ctx, px, py, pw, ph, Math.min(pw, ph) * 0.25);
			ctx.fill();
		}

		// Upper lid: a straight edge, tilted by `slant` (outer corner lower when positive).
		const outerCover = clamp(cur.upper + cur.slant * 0.35, 0, 1);
		const innerCover = clamp(cur.upper - cur.slant * 0.35, 0, 1);
		const leftCover = side < 0 ? outerCover : innerCover;
		const rightCover = side < 0 ? innerCover : outerCover;
		if (leftCover > 0.005 || rightCover > 0.005) {
			ctx.beginPath();
			ctx.moveTo(x - 2, y - 2);
			ctx.lineTo(x + w + 2, y - 2);
			ctx.lineTo(x + w + 2, y + h * rightCover);
			ctx.lineTo(x - 2, y + h * leftCover);
			ctx.fill();
		}
		// Lower lid: an arc pushing up from below, which reads as smiling cheeks.
		if (cur.lower > 0.005) {
			ctx.beginPath();
			ctx.ellipse(cx, y + h + h * 0.55 - cur.lower * h, w * 0.8, h * 0.55, 0, 0, Math.PI * 2);
			ctx.fill();
		}
		ctx.restore();
	}

	function drawClosedEye(cx, cy, w, H) {
		ctx.beginPath();
		ctx.moveTo(cx - w / 2, cy);
		ctx.quadraticCurveTo(cx, cy + H * 0.1, cx + w / 2, cy);
		ctx.strokeStyle = "#fff";
		ctx.lineWidth = Math.max(2, H * 0.035);
		ctx.lineCap = "round";
		ctx.stroke();
	}

	function drawZs(now, W, H) {
		ctx.fillStyle = "#fff";
		for (const offset of [0, 0.5]) {
			const t = ((now / 2600 + offset) % 1 + 1) % 1;
			ctx.globalAlpha = Math.sin(Math.PI * t) * 0.8;
			ctx.font = `600 ${H * (0.1 + t * 0.06)}px system-ui, sans-serif`;
			ctx.fillText("z", W * (0.8 + t * 0.06), H * (0.42 - t * 0.25));
		}
		ctx.globalAlpha = 1;
	}

	return { start, stop, setState, setLevel, cue };
}

/** A rough mood for replies that came without a [mood] tag. */
function inferMood(text) {
	if (LAUGH.test(text)) return "happy";
	if (/\b(sorry|unfortunately|sadly|afraid)\b/i.test(text)) return "sad";
	if (/\b(wow|whoa|really\?|no way)\b/i.test(text)) return "surprised";
	if (/!/.test(text)) return "excited";
	if (/\?\s*$/.test(text)) return "curious";
	return "neutral";
}

function roundRect(ctx, x, y, w, h, r) {
	if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
	else ctx.rect(x, y, w, h);
}

const smoothstep = (a, b, v) => {
	const t = clamp((v - a) / (b - a), 0, 1);
	return t * t * (3 - 2 * t);
};
const easeIn = (t) => t * t;
const easeOut = (t) => 1 - (1 - t) * (1 - t);
