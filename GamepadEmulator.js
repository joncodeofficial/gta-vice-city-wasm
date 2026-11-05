const defineProperty = Object.defineProperty;
const defineProperties = Object.defineProperties;
const getOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const getOwnPropertySymbols = Object.getOwnPropertySymbols;
const hasOwnProperty = Object.prototype.hasOwnProperty;
const propertyIsEnumerable = Object.prototype.propertyIsEnumerable;

const setProperty = (obj, key, value) => key in obj ? defineProperty(obj, key, {
	enumerable: true,
	configurable: true,
	writable: true,
	value: value
}) : obj[key] = value;

const mergeObjects = (target, source) => {
	for (var key in source || (source = {})) {
		if (hasOwnProperty.call(source, key)) {
			setProperty(target, key, source[key]);
		}
	}
	if (getOwnPropertySymbols) {
		for (var symbol of getOwnPropertySymbols(source)) {
			if (propertyIsEnumerable.call(source, symbol)) {
				setProperty(target, symbol, source[symbol]);
			}
		}
	}
	return target;
};

const definePropertiesFromSource = (target, source) => defineProperties(target, getOwnPropertyDescriptors(source));

const definePublicProperty = (obj, key, value) => setProperty(obj, typeof key !== "symbol" ? key + "" : key, value);

// Polyfill for modulepreload
(function() {
	const relList = document.createElement("link").relList;
	if (relList && relList.supports && relList.supports("modulepreload")) return;

	function getFetchOptions(link) {
		const options = {};
		if (link.integrity) options.integrity = link.integrity;
		if (link.referrerPolicy) options.referrerPolicy = link.referrerPolicy;
		if (link.crossOrigin === "use-credentials") {
			options.credentials = "include";
		} else if (link.crossOrigin === "anonymous") {
			options.credentials = "omit";
		} else {
			options.credentials = "same-origin";
		}
		return options;
	}

	function processModulePreload(link) {
		if (link.ep) return;
		link.ep = true;
		const options = getFetchOptions(link);
		fetch(link.href, options);
	}

	for (const link of document.querySelectorAll('link[rel="modulepreload"]')) {
		processModulePreload(link);
	}

	new MutationObserver(mutations => {
		for (const mutation of mutations) {
			if (mutation.type === "childList") {
				for (const node of mutation.addedNodes) {
					if (node.tagName === "LINK" && node.rel === "modulepreload") {
						processModulePreload(node);
					}
				}
			}
		}
	}).observe(document, {
		childList: true,
		subtree: true
	});
})();

var Direction = (dir => {
	dir.up = "up";
	dir.down = "down";
	dir.left = "left";
	dir.right = "right";
	return dir;
})(Direction || {});

var ControlType = (type => {
	type.onOff = "onOff";
	type.variable = "variable";
	return type;
})(ControlType || {});

var EmulationMode = (mode => {
	mode.real = "real";
	mode.emulated = "emulated";
	mode.overlay = "overlay";
	return mode;
})(EmulationMode || {});

var GamepadButton = (btn => {
	btn[btn.A = 0] = "A";
	btn[btn.B = 1] = "B";
	btn[btn.X = 2] = "X";
	btn[btn.Y = 3] = "Y";
	btn[btn.LShoulder = 4] = "LShoulder";
	btn[btn.RShoulder = 5] = "RShoulder";
	btn[btn.LTrigger = 6] = "LTrigger";
	btn[btn.RTrigger = 7] = "RTrigger";
	btn[btn.Back = 8] = "Back";
	btn[btn.Start = 9] = "Start";
	btn[btn.LStick = 10] = "LStick";
	btn[btn.RStick = 11] = "RStick";
	btn[btn.DPadUp = 12] = "DPadUp";
	btn[btn.DPadDown = 13] = "DPadDown";
	btn[btn.DPadLeft = 14] = "DPadLeft";
	btn[btn.DPadRight = 15] = "DPadRight";
	btn[btn.Vendor = 16] = "Vendor";
	return btn;
})(GamepadButton || {});

var GamepadAxis = (axis => {
	axis[axis.LStickX = 0] = "LStickX";
	axis[axis.LStickY = 1] = "LStickY";
	axis[axis.RStickX = 2] = "RStickX";
	axis[axis.RStickY = 3] = "RStickY";
	return axis;
})(GamepadAxis || {});

var GamepadElementClass = (cls => {
	cls.TapTarget = "gpad-tap-target";
	cls.ButtonIcon = "gpad-btn-icon";
	cls.ButtonShadow = "gpad-shadow";
	cls.ButtonHighlight = "gpad-highlight";
	cls.ButtonBackground = "gpad-btn-bg";
	cls.DirectionHighlight = "gpad-direction-highlight";
	cls.Thumbstick = "gpad-thumbstick";
	cls.GpadBaseShape = "gpad-base";
	cls.StickBaseShape = "gpad-stick-base";
	return cls;
})(GamepadElementClass || {});

const BUTTON_NAMES = [
	"button_1", "button_2", "button_3", "button_4",
	"shoulder_button_front_left", "shoulder_button_front_right",
	"shoulder_trigger_back_left", "shoulder_trigger_back_right",
	"select_button", "start_button",
	"stick_button_left", "stick_button_right",
	"dpad_up", "dpad_down", "dpad_left", "dpad_right"
];

const TAP_TARGET_NAMES = BUTTON_NAMES.map(name => name + "_tap_target");

const DIAGONAL_DPAD_MAPPING = {
	dpad_up_left_tap_target: [GamepadButton.DPadUp, GamepadButton.DPadLeft],
	dpad_up_right_tap_target: [GamepadButton.DPadUp, GamepadButton.DPadRight],
	dpad_down_left_tap_target: [GamepadButton.DPadDown, GamepadButton.DPadLeft],
	dpad_down_right_tap_target: [GamepadButton.DPadDown, GamepadButton.DPadRight]
};

class GamepadStateTracker {
	constructor(config) {
		definePublicProperty(this, "updateDelay");
		definePublicProperty(this, "axisDeadZone");
		definePublicProperty(this, "buttonConfigs");
		definePublicProperty(this, "currentStateOfGamepads");
		definePublicProperty(this, "gamepadConnectListeners");
		definePublicProperty(this, "gamepadDisconnectListeners");
		definePublicProperty(this, "gamepadButtonChangeListeners");
		definePublicProperty(this, "gamepadAxisChangeListeners");
		definePublicProperty(this, "_requestAnimationFrame");
		definePublicProperty(this, "_getGamepads");

		this.updateDelay = config.updateDelay || 0;
		this.axisDeadZone = config.axisDeadZone || 0;
		this.buttonConfigs = config.buttonConfigs || [];
		this.currentStateOfGamepads = [];
		this.gamepadConnectListeners = [];
		this.gamepadDisconnectListeners = [];
		this.gamepadButtonChangeListeners = [];
		this.gamepadAxisChangeListeners = [];

		navigator.gamepadInputEmulation = "gamepad";

		this._requestAnimationFrame = window.requestAnimationFrame ||
			window.mozRequestAnimationFrame ||
			window.webkitRequestAnimationFrame ||
			window.msRequestAnimationFrame;

		this._getGamepads = navigator.getGamepads ||
			navigator.webkitGetGamepads ||
			navigator.mozGetGamepads ||
			navigator.msGetGamepads;

		if (this.gamepadApiSupported() || navigator.getNativeGamepads !== undefined) {
			this.tickLoop();
		}
	}

	setButtonsConfig(config) {
		this.buttonConfigs = config;
	}

	setUpdateDelay(delay) {
		this.updateDelay = delay;
	}

	onGamepadConnect(listener) {
		this.gamepadConnectListeners.push(listener);
		window.addEventListener("gamepadconnected", listener, true);
		return listener;
	}

	offGamepadConnect(listener) {
		this.gamepadConnectListeners = this.gamepadConnectListeners.filter(l => l !== listener);
		window.removeEventListener("gamepadconnected", listener, true);
	}

	onGamepadDisconnect(listener) {
		this.gamepadDisconnectListeners.push(listener);
		window.addEventListener("gamepaddisconnected", listener, true);
		return listener;
	}

	offGamepadDisconnect(listener) {
		this.gamepadDisconnectListeners = this.gamepadDisconnectListeners.filter(l => l !== listener);
		window.removeEventListener("gamepaddisconnected", listener, true);
	}

	onGamepadAxisChange(listener) {
		this.gamepadAxisChangeListeners.push(listener);
		return listener;
	}

	offGamepadAxisChange(listener) {
		this.gamepadAxisChangeListeners = this.gamepadAxisChangeListeners.filter(l => l !== listener);
	}

	onGamepadButtonChange(listener) {
		this.gamepadButtonChangeListeners.push(listener);
		return listener;
	}

	offGamepadButtonChange(listener) {
		this.gamepadButtonChangeListeners = this.gamepadButtonChangeListeners.filter(l => l !== listener);
	}

	gamepadApiSupported() {
		const getGamepads = navigator.getNativeGamepads ||
			navigator.getGamepads ||
			navigator.webkitGetGamepads ||
			navigator.mozGetGamepads ||
			navigator.msGetGamepads;

		if (getGamepads != null && typeof getGamepads === "function") {
			try {
				const gamepads = getGamepads.apply(navigator);
				return gamepads != null && (gamepads[0] !== undefined || gamepads.length !== 0 || window.isSecureContext);
			} catch (e) {
				return false;
			}
		} else {
			return false;
		}
	}

	getGamepads() {
		const getGamepads = navigator.getGamepads ||
			navigator.webkitGetGamepads ||
			navigator.mozGetGamepads ||
			navigator.msGetGamepads;

		return (getGamepads && typeof getGamepads === "function") ? (getGamepads.apply(navigator) || []) : [];
	}

	getCurrentGamepadStates(forceCheck = false) {
		if (forceCheck) {
			this.checkForGamepadChanges();
		}
		return this.currentStateOfGamepads;
	}

	cleanup() {
		this.updateDelay = -1;
		this.gamepadConnectListeners.forEach(l => window.removeEventListener("gamepadconnected", l, true));
		this.gamepadDisconnectListeners.forEach(l => window.removeEventListener("gamepaddisconnected", l, true));
		this.gamepadConnectListeners = [];
		this.gamepadDisconnectListeners = [];
		this.gamepadButtonChangeListeners = [];
		this.gamepadAxisChangeListeners = [];
	}

	tickLoop() {
		if (this.updateDelay < 0) return;

		this.checkForGamepadChanges();

		if (this.updateDelay === 0) {
			requestAnimationFrame(this.tickLoop.bind(this));
		} else {
			setTimeout(() => {
				requestAnimationFrame(this.tickLoop.bind(this));
			}, this.updateDelay);
		}
	}

	checkForGamepadChanges() {
		let gamepads = this.getGamepads();
		for (let i = 0; i < gamepads.length; i++) {
			let gamepad = gamepads[i];
			if (gamepad) {
				this.checkForAxisChanges(i, gamepad);
				this.checkForButtonChanges(i, gamepad);
				this.currentStateOfGamepads[i] = gamepad;
			}
		}
	}

	checkForAxisChanges(index, gamepad) {
		let axes = gamepad.axes;
		if (axes.length === 0) return;

		const prevState = this.currentStateOfGamepads[index];
		let prevAxes = (prevState?.axes) || [];
		let changedAxes = [];
		let hasChanges = false;

		for (let i = 0; i < axes.length; i++) {
			let currentVal = axes[i] || 0;
			let prevVal = prevAxes[i] || 0;

			if (currentVal !== prevVal) {
				if (Math.abs(currentVal) < this.axisDeadZone && Math.abs(prevVal) < this.axisDeadZone) {
					continue;
				}
				changedAxes[i] = true;
				hasChanges = true;
			} else {
				changedAxes[i] = false;
			}
		}

		if (hasChanges) {
			this.gamepadAxisChangeListeners.forEach(listener => listener(index, gamepad, changedAxes));
		}
	}

	checkForButtonChanges(index, gamepad) {
		let buttons = gamepad.buttons;
		if (buttons.length === 0) return;

		const prevState = this.currentStateOfGamepads[index];
		const prevButtons = (prevState?.buttons) || buttons;
		const changedButtons = new Array(buttons.length).fill(false);
		let hasChanges = false;

		for (let i = 0; i < buttons.length; i++) {
			let changed = false;
			const currentBtn = buttons[i] || {
				pressed: false,
				value: 0,
				touched: false
			};
			const prevBtn = prevButtons[i] || {
				pressed: false,
				value: 0,
				touched: false
			};
			const config = this.buttonConfigs[i] || {};
			const changes = {};

			if (currentBtn.touched && !prevBtn.touched) {
				changes.touchDown = true;
				changed = true;
			} else if (!currentBtn.touched && prevBtn.touched) {
				changes.touchUp = true;
				changed = true;
			}

			if (currentBtn.pressed && !prevBtn.pressed) {
				changes.pressed = true;
				changed = true;
			} else if (!currentBtn.pressed && prevBtn.pressed) {
				changes.released = true;
				changed = true;
			}

			if (config.fireWhileHolding && currentBtn.pressed && prevBtn.pressed) {
				changes.heldDown = true;
				changed = true;
			}

			if (currentBtn.value !== prevBtn.value) {
				changes.valueChanged = true;
				changed = true;
			}

			if (changed) {
				hasChanges = true;
				changedButtons[i] = changes;
			} else {
				changedButtons[i] = false;
			}
		}

		if (hasChanges) {
			this.gamepadButtonChangeListeners.forEach(listener => listener(index, gamepad, changedButtons));
		}
	}
}

function normalizeVector(x, y, maxDistance) {
	const distance = Math.sqrt(x * x + y * y);
	if (distance > maxDistance) {
		return {
			x: x / distance,
			y: y / distance
		};
	} else {
		return {
			x: x / maxDistance,
			y: y / maxDistance
		};
	}
}

function setTransformOriginToCenter(element) {
	if (element instanceof SVGGraphicsElement) {
		if (element.getAttribute("transform")) {
			console.warn("VirtualGamepadLib: Setting Transform origin on an element that already has a transform attribute. This may break the transform!", element);
		}
		const bbox = element.getBBox();
		element.style.transformOrigin = `${bbox.x + bbox.width / 2}px ${bbox.y + bbox.height / 2}px`;
	} else if (element instanceof HTMLElement) {
		console.warn("VirtualGamepadLib: Setting Transform origin on an element that is not an SVG element. This may break the transform!", element);
		const rect = element.getBoundingClientRect();
		element.style.transformOrigin = `${rect.width / 2}px ${rect.height / 2}px`;
	}
}

const DEFAULT_BUTTON_COUNT = 18;
const DEFAULT_AXIS_COUNT = 4;

class GamepadEmulator {
	constructor(buttonPressThreshold) {
		definePublicProperty(this, "getNativeGamepads");
		definePublicProperty(this, "buttonPressThreshold", 0.1);
		definePublicProperty(this, "realGpadToPatchedIndexMap", []);
		definePublicProperty(this, "patchedGpadToRealIndexMap", []);
		definePublicProperty(this, "emulatedGamepads", []);
		definePublicProperty(this, "emulatedGamepadsMetadata", []);
		definePublicProperty(this, "undoEventPatch", () => {});

		definePublicProperty(this, "AddDisplayButtonEventListeners", this.AddButtonTouchEventListeners);
		definePublicProperty(this, "AddDisplayJoystickEventListeners", this.AddJoystickTouchEventListeners);
		definePublicProperty(this, "ClearDisplayButtonEventListeners", this.ClearButtonTouchEventListeners);
		definePublicProperty(this, "ClearDisplayJoystickEventListeners", this.ClearJoystickTouchEventListeners);

		this.buttonPressThreshold = buttonPressThreshold || this.buttonPressThreshold;

		if (GamepadEmulator.instanceRunning) {
			throw new Error("Only one GamepadEmulator instance may exist at a time!");
		}
		GamepadEmulator.instanceRunning = true;

		this.undoEventPatch = this.monkeyPatchGamepadEvents();
		this.monkeyPatchGetGamepads();
	}

	gamepadApiNativelySupported() {
		return !!this.getNativeGamepads && !!this.getNativeGamepads.apply(navigator);
	}

	AddEmulatedGamepad(index, overlayMode, buttonCount = DEFAULT_BUTTON_COUNT, axisCount = DEFAULT_AXIS_COUNT) {
		if ((index === -1 || (!index && index !== 0))) {
			index = this.nextEmptyEGpadIndex(overlayMode);
		}

		if (this.emulatedGamepads[index]) return false;

		const gamepad = {
			emulation: EmulationMode.emulated,
			connected: true,
			timestamp: performance.now(),
			displayId: "Emulated Gamepad " + index,
			id: "Emulated Gamepad " + index + " (Xinput STANDARD GAMEPAD)",
			mapping: "standard",
			index: index,
			buttons: new Array(buttonCount).fill({
				pressed: false,
				value: 0,
				touched: false
			}, 0, buttonCount),
			axes: new Array(axisCount).fill(0, 0, axisCount),
			hapticActuators: []
		};

		this.emulatedGamepads[index] = gamepad;
		this.emulatedGamepadsMetadata[index] = {
			overlayMode: overlayMode
		};

		const event = new Event("gamepadconnected");
		event.gamepad = gamepad;
		window.dispatchEvent(event);

		return gamepad;
	}

	RemoveEmulatedGamepad(index) {
		this.ClearButtonTouchEventListeners(index);
		this.ClearJoystickTouchEventListeners(index);

		const gamepad = this.emulatedGamepads[index];
		if (gamepad) {
			delete this.emulatedGamepads[index];
			delete this.emulatedGamepadsMetadata[index];

			const disconnectedGamepad = definePropertiesFromSource(mergeObjects({}, gamepad), {
				connected: false,
				timestamp: performance.now()
			});

			const event = new Event("gamepaddisconnected");
			event.gamepad = disconnectedGamepad;
			window.dispatchEvent(event);
		} else {
			console.warn("GamepadEmulator Error: Cannot remove emulated gamepad. No emulated gamepad exists at index " + index);
		}
	}

	PressButton(gamepadIndex, buttonIndexOrIndices, value, touched) {
		if (this.emulatedGamepads[gamepadIndex] == null) {
			throw new Error("Error: PressButton() - no emulated gamepad at index " + gamepadIndex + ", pass a valid index, or call AddEmulatedGamepad() first to create an emulated gamepad at that index");
		}

		const buttons = [...(this.emulatedGamepads[gamepadIndex]?.buttons || [])];
		const isPressed = value > this.buttonPressThreshold;

		if (Array.isArray(buttonIndexOrIndices)) {
			const isTouched = isPressed || (touched ?? buttons[buttonIndexOrIndices[0]]?.touched) || false;
			for (let i = 0; i < buttonIndexOrIndices.length; i++) {
				const idx = buttonIndexOrIndices[i];
				if (idx < 0 || idx >= this.emulatedGamepads[gamepadIndex].buttons.length) {
					console.error("Error: PressButton() - button index " + idx + " out of range, pass a valid index between 0 and " + (this.emulatedGamepads[gamepadIndex].buttons.length - 1));
					continue;
				}
				buttons[idx] = {
					pressed: isPressed,
					value: value || 0,
					touched: isTouched
				};
			}
		} else {
			const isTouched = isPressed || (touched ?? buttons[buttonIndexOrIndices]?.touched) || false;
			if (buttonIndexOrIndices < 0 || buttonIndexOrIndices >= this.emulatedGamepads[gamepadIndex].buttons.length) {
				console.error("Error: PressButton() - button index " + buttonIndexOrIndices + " out of range, pass a valid index between 0 and " + (this.emulatedGamepads[gamepadIndex].buttons.length - 1));
				return;
			}
			buttons[buttonIndexOrIndices] = {
				pressed: isPressed,
				value: value || 0,
				touched: isTouched
			};
		}

		defineProperty(this.emulatedGamepads[gamepadIndex], "buttons", {
			value: buttons,
			enumerable: true,
			configurable: true
		});
	}

	MoveAxis(gamepadIndex, axisIndex, value) {
		if (this.emulatedGamepads[gamepadIndex] == null) {
			throw new Error("Error: MoveAxis() - no emulated gamepad at index " + gamepadIndex + ", pass a valid index, or call AddEmulatedGamepad() first to create an emulated gamepad at that index");
		}

		const axes = [...(this.emulatedGamepads[gamepadIndex]?.axes || [])];
		axes[axisIndex] = value;

		defineProperty(this.emulatedGamepads[gamepadIndex], "axes", {
			value: axes,
			enumerable: true,
			configurable: true
		});
	}

	AddButtonTouchEventListeners(gamepadIndex, buttonConfigs) {
		if (!this.emulatedGamepads[gamepadIndex]) {
			throw new Error("Error: AddJoystickTouchEventListeners() - no emulated gamepad at index " + gamepadIndex + ", pass a valid index, or call AddEmulatedGamepad() first to create an emulated gamepad at that index");
		}

		let cleanupFuncs = [];

		for (let i = 0; i < buttonConfigs.length; i++) {
			const config = buttonConfigs[i];
			if (!config) continue;

			const buttonIndices = config.buttonIndexes ?? config.buttonIndex;
			const tapTarget = config.tapTarget;

			if (!tapTarget) {
				console.warn("GamepadEmulator: No tap target in gamepad " + gamepadIndex + " display config for button " + buttonIndices + ", skipping...");
				continue;
			}

			const onTouchStart = (e) => {
				const target = e.changedTouches[0].target;
				if (target === tapTarget || target.parentElement === tapTarget) {
					e.preventDefault();
				}
			};
			window.addEventListener("touchstart", onTouchStart, {
				passive: false
			});

			const onPointerEnter = (e) => {
				const isPressed = e.buttons === 1 ? 1 : 0;
				if (!config.lockTargetWhilePressed || isPressed === 0) {
					this.PressButton(gamepadIndex, buttonIndices, isPressed, true);
				}
			};
			tapTarget.addEventListener("pointerenter", onPointerEnter);

			const onPointerLeave = (e) => {
				const isPressed = e.buttons === 1 ? 1 : 0;
				if (!config.lockTargetWhilePressed || isPressed === 0) {
					this.PressButton(gamepadIndex, buttonIndices, 0, false);
				}
			};
			tapTarget.addEventListener("pointerleave", onPointerLeave);

			const onPointerCancel = (e) => {
				this.PressButton(gamepadIndex, buttonIndices, 0, false);
			};
			tapTarget.addEventListener("pointercancel", onPointerCancel);

			if (config.type === ControlType.onOff) {
				const onPointerDown = (e) => {
					e.preventDefault();
					this.PressButton(gamepadIndex, buttonIndices, 1, true);
					if (config.lockTargetWhilePressed) {
						tapTarget.setPointerCapture(e.pointerId);
					} else {
						tapTarget.releasePointerCapture(e.pointerId);
					}
				};
				tapTarget.addEventListener("pointerdown", onPointerDown);

				const onPointerUp = () => {
					this.PressButton(gamepadIndex, buttonIndices, 0);
				};
				tapTarget.addEventListener("pointerup", onPointerUp);

				cleanupFuncs.push(() => {
					window.removeEventListener("touchstart", onTouchStart);
					tapTarget.removeEventListener("pointerenter", onPointerEnter);
					tapTarget.removeEventListener("pointerleave", onPointerLeave);
					tapTarget.removeEventListener("pointerdown", onPointerDown);
					tapTarget.removeEventListener("pointerup", onPointerUp);
					tapTarget.removeEventListener("pointercancel", onPointerCancel);
				});
			} else if (config.type === ControlType.variable) {
				const removeDragListener = this.AddDragControlListener(config, (isDragging, x, y) => {
					let val = isDragging ? this.buttonPressThreshold + 0.00001 : 0;
					val += (config.directions[Direction.left] || config.directions[Direction.right]) ? Math.abs(x) : 0;
					val += (config.directions[Direction.up] || config.directions[Direction.down]) ? Math.abs(y) : 0;
					this.PressButton(gamepadIndex, buttonIndices, Math.min(val, 1));
				});

				cleanupFuncs.push(() => {
					window.removeEventListener("touchstart", onTouchStart);
					tapTarget.removeEventListener("pointerenter", onPointerEnter);
					tapTarget.removeEventListener("pointerleave", onPointerLeave);
					tapTarget.removeEventListener("pointercancel", onPointerCancel);
					removeDragListener();
				});
			}
		}

		this.emulatedGamepadsMetadata[gamepadIndex].removeButtonListenersFunc = () => {
			cleanupFuncs.forEach(fn => fn());
		};
	}

	AddJoystickTouchEventListeners(gamepadIndex, joystickConfigs) {
		if (!this.emulatedGamepads[gamepadIndex]) {
			throw new Error("Error: AddJoystickTouchEventListeners() - no emulated gamepad at index " + gamepadIndex + ", pass a valid index, or call AddEmulatedGamepad() first to create an emulated gamepad at that index");
		}

		let cleanupFuncs = [];

		for (let i = 0; i < joystickConfigs.length; i++) {
			const config = joystickConfigs[i];
			if (!config) continue;

			if (config.tapTarget == null) {
				console.warn("GamepadEmulator: No tap target in gamepad " + gamepadIndex + " display config for joystick " + i + ", skipping...");
				continue;
			}

			const removeDragListener = this.AddDragControlListener(config, (isDragging, x, y) => {
				if (config.xAxisIndex !== undefined) {
					this.MoveAxis(gamepadIndex, config.xAxisIndex, x);
				}
				if (config.yAxisIndex !== undefined) {
					this.MoveAxis(gamepadIndex, config.yAxisIndex, y);
				}
			});
			cleanupFuncs.push(removeDragListener);
		}

		this.emulatedGamepadsMetadata[gamepadIndex].removeJoystickListenersFunc = () => {
			cleanupFuncs.forEach(fn => fn());
		};
	}

	ClearButtonTouchEventListeners(gamepadIndex) {
		const metadata = this.emulatedGamepadsMetadata[gamepadIndex];
		if (metadata && metadata.removeButtonListenersFunc) {
			metadata.removeButtonListenersFunc();
		}
	}

	ClearJoystickTouchEventListeners(gamepadIndex) {
		const metadata = this.emulatedGamepadsMetadata[gamepadIndex];
		if (metadata && metadata.removeJoystickListenersFunc) {
			metadata.removeJoystickListenersFunc();
		}
	}

	AddDragControlListener(config, callback) {
		let startPos = {
			startX: 0,
			startY: 0
		};
		let activePointerId = -1;

		const onPointerMove = (e) => {
			if (activePointerId === e.pointerId) {
				const minX = config.directions[Direction.left] ? -1 : 0;
				const maxX = config.directions[Direction.right] ? 1 : 0;
				const minY = config.directions[Direction.up] ? -1 : 0;
				const maxY = config.directions[Direction.down] ? 1 : 0;

				const deltaX = e.clientX - startPos.startX;
				const deltaY = e.clientY - startPos.startY;

				let {
					x,
					y
				} = normalizeVector(deltaX, deltaY, config.dragDistance);

				x = Math.max(Math.min(x, maxX), minX);
				y = Math.max(Math.min(y, maxY), minY);

				callback(true, x, y);
			}
		};

		const onPointerUp = (e) => {
			if (activePointerId === e.pointerId) {
				document.removeEventListener("pointermove", onPointerMove, false);
				document.removeEventListener("pointerup", onPointerUp, false);
				activePointerId = -1;
				callback(false, 0, 0);
			}
		};

		config.tapTarget.addEventListener("pointerdown", (e) => {
			e.preventDefault();
			startPos.startX = e.clientX;
			startPos.startY = e.clientY;
			activePointerId = e.pointerId;

			if (config.lockTargetWhilePressed) {
				config.tapTarget.setPointerCapture(e.pointerId);
			} else {
				config.tapTarget.releasePointerCapture(e.pointerId);
			}

			callback(true, 0, 0);
			document.addEventListener("pointermove", onPointerMove, false);
			document.addEventListener("pointerup", onPointerUp, false);
		});

		const onTouchStart = (e) => {
			if (e.changedTouches[0].target === config.tapTarget) {
				e.preventDefault();
			}
		};

		window.addEventListener("touchstart", onTouchStart, {
			passive: false
		});

		return function cleanup() {
			window.removeEventListener("touchstart", onTouchStart);
			config.tapTarget.removeEventListener("pointerdown", onPointerMove); // Note: This looks like a bug in original code, should probably be the pointerdown listener
		};
	}

	cloneGamepad(gamepad) {
		if (!gamepad) return gamepad;

		const axisCount = gamepad.axes ? gamepad.axes.length : 0;
		const buttonCount = gamepad.buttons ? gamepad.buttons.length : 0;
		const clone = {};

		for (let key in gamepad) {
			if (key === "axes") {
				const axes = new Array(axisCount);
				for (let i = 0; i < axisCount; i++) {
					axes[i] = Number(gamepad.axes[i]);
				}
				defineProperty(clone, "axes", {
					value: axes,
					enumerable: true,
					configurable: true
				});
			} else if (key === "buttons") {
				const buttons = new Array(buttonCount);
				for (let i = 0; i < buttonCount; i++) {
					const btn = gamepad.buttons[i];
					if (btn == null) {
						buttons[i] = btn;
					} else {
						buttons[i] = {
							pressed: btn.pressed,
							value: btn.value,
							touched: btn.touched || false
						};
					}
				}
				defineProperty(clone, "buttons", {
					value: buttons,
					enumerable: true,
					configurable: true
				});
			} else {
				defineProperty(clone, key, {
					get: () => gamepad[key],
					configurable: true,
					enumerable: true
				});
			}
		}

		if (!clone.emulation) {
			defineProperty(clone, "emulation", {
				value: EmulationMode.real,
				configurable: true,
				enumerable: true
			});
		}

		return clone;
	}

	nextEmptyEGpadIndex(overlayMode) {
		let index = 0;
		if (overlayMode) {
			do {
				if (!this.emulatedGamepads[index]) break;
				index++;
			} while (index < this.emulatedGamepads.length);
		} else {
			const maxLen = Math.max(this.emulatedGamepads.length, this.patchedGpadToRealIndexMap.length);
			do {
				if (!this.emulatedGamepads[index] && this.patchedGpadToRealIndexMap[index] == null) break;
				index++;
			} while (index < maxLen);
		}
		return index;
	}

	nextEmptyRealGpadIndex(startIndex) {
		let index = startIndex;
		const maxLen = Math.max(this.emulatedGamepads.length, this.patchedGpadToRealIndexMap.length);
		do {
			const metadata = this.emulatedGamepadsMetadata[index];
			const isFree = this.realGpadToPatchedIndexMap[index] == null && this.patchedGpadToRealIndexMap[index] == null;
			if ((metadata && metadata.overlayMode && this.patchedGpadToRealIndexMap[index] == null) || (!metadata && isFree)) break;
			index++;
		} while (index < maxLen);
		return index;
	}

	// From 0, not the real index: the game reads only pad 0, where the touch overlay sits. Lazy, so pads
	// connected before the emulator existed get mapped too.
	patchedIndexFor(realIndex) {
		let patchedIndex = this.realGpadToPatchedIndexMap[realIndex];
		if (patchedIndex == null) {
			patchedIndex = this.nextEmptyRealGpadIndex(0);
			this.realGpadToPatchedIndexMap[realIndex] = patchedIndex;
			this.patchedGpadToRealIndexMap[patchedIndex] = realIndex;
		}
		return patchedIndex;
	}

	monkeyPatchGamepadEvents() {
		let originalOnConnectDescriptor, originalOnDisconnectDescriptor;
		let onConnectHandler, onDisconnectHandler;

		if (window.hasOwnProperty("ongamepadconnected")) {
			originalOnConnectDescriptor = Object.getOwnPropertyDescriptor(window, "ongamepadconnected");
			originalOnConnectDescriptor.configurable = true;
			onConnectHandler = window.ongamepadconnected;
			window.ongamepadconnected = null;

			Object.defineProperty(window, "ongamepadconnected", {
				get: () => function(e) {},
				set: (handler) => {
					onConnectHandler = handler;
				},
				configurable: true
			});
		}

		if (window.hasOwnProperty("ongamepaddisconnected")) {
			originalOnDisconnectDescriptor = Object.getOwnPropertyDescriptor(window, "ongamepaddisconnected");
			originalOnDisconnectDescriptor.configurable = true;
			onDisconnectHandler = window.ongamepaddisconnected;
			window.ongamepaddisconnected = null;

			Object.defineProperty(window, "ongamepaddisconnected", {
				get: () => function(e) {},
				set: (handler) => {
					onDisconnectHandler = handler;
				},
				configurable: true
			});
		}

		const handleConnect = (event) => {
			const gamepad = event.gamepad;
			if (gamepad && gamepad.emulation === undefined) {
				event.stopImmediatePropagation();
				event.preventDefault();

				const cloned = this.cloneGamepad(event.gamepad);
				const patchedIndex = this.patchedIndexFor(cloned.index);

				Object.defineProperty(cloned, "index", {
					get: () => patchedIndex
				});
				Object.defineProperty(cloned, "emulation", {
					get: () => EmulationMode.real
				});

				const newEvent = new Event(event.type || "gamepadconnected");
				newEvent.gamepad = cloned;
				window.dispatchEvent(newEvent);
			}
			if (onConnectHandler) onConnectHandler.call(window, event);
		};
		window.addEventListener("gamepadconnected", handleConnect);

		const handleDisconnect = (event) => {
			const gamepad = event.gamepad;
			if (gamepad && gamepad.emulation === undefined) {
				event.stopImmediatePropagation();
				event.preventDefault();

				const cloned = this.cloneGamepad(event.gamepad);
				const patchedIndex = this.realGpadToPatchedIndexMap[cloned.index] ?? cloned.index;

				Object.defineProperty(cloned, "index", {
					get: () => patchedIndex
				});
				Object.defineProperty(cloned, "emulation", {
					get: () => EmulationMode.real
				});

				delete this.realGpadToPatchedIndexMap[gamepad.index];
				delete this.patchedGpadToRealIndexMap[patchedIndex];

				const newEvent = new Event(event.type || "gamepaddisconnected");
				newEvent.gamepad = cloned;
				window.dispatchEvent(newEvent);
			}
			if (onDisconnectHandler) onDisconnectHandler.call(window, event);
		};
		window.addEventListener("gamepaddisconnected", handleDisconnect);

		return function undo() {
			window.removeEventListener("gamepadconnected", handleConnect);
			if (window.hasOwnProperty("ongamepadconnected")) {
				Object.defineProperty(window, "ongamepadconnected", originalOnConnectDescriptor);
				window.ongamepadconnected = onConnectHandler;
			}
			window.removeEventListener("gamepaddisconnected", handleDisconnect);
			if (window.hasOwnProperty("ongamepaddisconnected")) {
				Object.defineProperty(window, "ongamepaddisconnected", originalOnDisconnectDescriptor);
				window.ongamepaddisconnected = onDisconnectHandler;
			}
		};
	}

	monkeyPatchGetGamepads() {
		const self = this;
		const originalGetGamepads = navigator.getGamepads ||
			navigator.webkitGetGamepads ||
			navigator.mozGetGamepads ||
			navigator.msGetGamepads;

		this.getNativeGamepads = originalGetGamepads;
		navigator.getNativeGamepads = originalGetGamepads || function() {
			return [];
		};

		Object.defineProperty(navigator, "getGamepads", {
			configurable: true,
			value: function() {
				const emulated = self.emulatedGamepads;
				const real = originalGetGamepads ? (originalGetGamepads.apply(navigator) || []) : [];
				const result = new Array(Math.max(real.length, emulated.length)).fill(null);

				for (let i = 0; i < real.length; i++) {
					const gamepad = real[i];
					if (!gamepad) continue;

					let cloned = self.cloneGamepad(gamepad);
					let patchedIndex = self.patchedIndexFor(cloned.index);

					Object.defineProperty(cloned, "index", {
						get: () => patchedIndex
					});
					result[patchedIndex] = cloned;
				}

				for (let i = 0; i < emulated.length; i++) {
					let existing = result[i];
					let emu = emulated[i];

					if (emu && existing) {
						Object.defineProperty(result[i], "emulation", {
							value: EmulationMode.overlay,
							configurable: true
						});

						let btnCount = Math.max(existing.buttons?.length || 0, emu.buttons.length);
						let buttons = new Array(btnCount);

						for (let j = 0; j < btnCount; j++) {
							const emuBtn = emu.buttons[j] || {
								touched: false,
								pressed: false,
								value: 0
							};
							const realBtn = existing.buttons[j] || {
								touched: false,
								pressed: false,
								value: 0
							};
							buttons[j] = {
								touched: emuBtn.touched || realBtn.touched || false,
								pressed: emuBtn.pressed || realBtn.pressed || false,
								value: Math.max(emuBtn.value, realBtn.value) || 0
							};
						}

						Object.defineProperty(result[i], "buttons", {
							value: buttons,
							enumerable: true,
							configurable: true
						});

						let axisCount = Math.max(emu.axes.length, existing.axes.length);
						let axes = new Array(axisCount);

						for (let j = 0; j < axisCount; j++) {
							const emuAxis = emu.axes[j] ?? 0;
							const realAxis = existing.axes[j] ?? 0;
							axes[j] = Math.abs(emuAxis) > Math.abs(realAxis) ? emuAxis : realAxis;
						}

						Object.defineProperty(result[i], "axes", {
							value: axes,
							enumerable: true,
							configurable: true
						});
					} else if (emu) {
						Object.defineProperty(emu, "emulation", {
							value: EmulationMode.emulated,
							enumerable: true,
							configurable: true
						});
						Object.defineProperty(emu, "timestamp", {
							value: performance.now(),
							enumerable: true,
							configurable: true
						});
						result[i] = self.cloneGamepad(emu);
					}
				}
				return result;
			}
		});
	}

	cleanup() {
		for (let i = 0; i < this.emulatedGamepads.length; i++) {
			this.ClearButtonTouchEventListeners(i);
			this.ClearJoystickTouchEventListeners(i);
		}
		this.emulatedGamepads = [];
		this.undoEventPatch();

		if (this.getNativeGamepads) {
			Object.defineProperty(navigator, "getGamepads", {
				value: this.getNativeGamepads,
				configurable: true
			});
		} else {
			Object.defineProperty(navigator, "getGamepads", {
				value: undefined,
				configurable: true
			});
		}

		GamepadEmulator.instanceRunning = false;
		delete navigator.getNativeGamepads;
	}
}

definePublicProperty(GamepadEmulator, "instanceRunning", false);
