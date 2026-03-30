const cloudSavesStatus = document.getElementById('cloud-saves-status');
var statusElement = document.getElementById("status");
var progressElement = document.getElementById("progress");
var spinnerElement = document.getElementById('spinner');
var data_content;
var wasm_content;

const params = new URLSearchParams(window.location.search);

// Base URLs
const replaceFetch = (str) => str.replace("https://cdn.dos.zone/vcsky/", "/vcsky/")
const replaceBR = "/vcbr/"

// Configurable mode - show settings UI before play
const configurableMode = params.get('configurable') === "1";

// Settings that can be configured via URL or UI
let autoFullScreen = params.get('fullscreen') !== "0";
let cheatsEnabled = params.get('cheats') === "1" || configurableMode;
let maxFPS = parseInt(params.get('max_fps')) || 0;

const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
let isTouch = isMobile && window.matchMedia('(pointer: coarse)').matches;

document.body.dataset.isTouch = isTouch ? 1 : 0;

const dataSize = 130 * 1024 * 1024;
const textDecoder = new TextDecoder();
let haveOriginalGame = true;

async function resumeAudioContexts() {
    const contexts = [];

    const moduleAudioContext = globalThis.Module?.SDL2?.audioContext;
    if (moduleAudioContext) {
        contexts.push(moduleAudioContext);
    }

    const openAlContext = globalThis.AL?.currentCtx?.audioCtx;
    if (openAlContext) {
        contexts.push(openAlContext);
    }

    for (const context of contexts) {
        if (context?.state === "suspended") {
            try {
                await context.resume();
            } catch (error) {
                console.warn("Audio resume failed:", error);
            }
        }
    }
}
const translations = {
    en: {
        clickToPlay: "Start to play",
        invalidKey: "invalid key",
        checking: "checking...",
        cloudSaves: "Cloud saves:",
        enabled: "enabled",
        disabled: "disabled",
        disclaimer: "DISCLAIMER:",
        disclaimerSources: "This game is based on an open source version of GTA: Vice City. It is not a commercial release and is not affiliated with Rockstar Games.",
        disclaimerCheckbox: "",
        disclaimerPrompt: "",
        cantContinuePlaying: "",
        downloading: "Downloading",
        enterKey: "enter your key",
        clickToContinue: "Click to continue...",
        enterJsDosKey: "Enter js-dos key (5 len)",
        portBy: "WASM engine by:",
        configLanguage: "Language:",
        configCheats: "Cheats (F3)",
        configFullscreen: "Fullscreen",
        configMaxFps: "Max FPS:",
        configUnlimited: "(0 = unlimited)",
    },
};

var currentLanguage = "en";

window.t = function (key) {
    return translations[currentLanguage][key];
}

// Function to update all translated texts on the page
function updateAllTranslations() {
    const keyInput = document.querySelector('.jsdos-key-input');
    if (keyInput) keyInput.setAttribute('placeholder', t("enterJsDosKey"));
    
    const clickToPlayButton = document.getElementById('click-to-play-button');
    if (clickToPlayButton) {
        clickToPlayButton.textContent = t('clickToPlay');
    }

    const cloudSavesLink = document.getElementById('cloud-saves-link');
    if (cloudSavesLink) cloudSavesLink.textContent = t('cloudSaves');

    const cloudSavesStatus = document.getElementById('cloud-saves-status');
    if (cloudSavesStatus) cloudSavesStatus.textContent = t('enterKey');
    
    const disclaimerText = document.getElementById('disclaimer-text');
    if (disclaimerText) disclaimerText.textContent = t('disclaimer');
    
    const disclaimerSources = document.getElementById('disclaimer-sources');
    if (disclaimerSources) disclaimerSources.textContent = t('disclaimerSources');
    
    const portBy = document.getElementById('port-by');
    if (portBy) portBy.textContent = t('portBy');
    
    // Update config panel labels if present
    const configLangLabel = document.getElementById('config-lang-label');
    if (configLangLabel) configLangLabel.textContent = t('configLanguage');
    
    const configCheatsLabel = document.getElementById('config-cheats-label');
    if (configCheatsLabel) configCheatsLabel.textContent = t('configCheats');
    
    const configFullscreenLabel = document.getElementById('config-fullscreen-label');
    if (configFullscreenLabel) configFullscreenLabel.textContent = t('configFullscreen');
    
    const configMaxFpsLabel = document.getElementById('config-max-fps-label');
    if (configMaxFpsLabel) configMaxFpsLabel.textContent = t('configMaxFps');
    
    const configMaxFpsUnlimited = document.getElementById('config-max-fps-unlimited');
    if (configMaxFpsUnlimited) configMaxFpsUnlimited.textContent = t('configUnlimited');
}

// Function to update game data files based on language
function updateGameDataForLanguage(lang) {
    data_content = `${replaceBR}vc-sky-en-v6.data`;
    wasm_content = `${replaceBR}vc-sky-en-v6.wasm`;
}

// Initialize data files based on current language
updateGameDataForLanguage(currentLanguage);

async function loadData() {
    const response = await fetch(data_content, { cache: 'no-store' });
    if (!response.ok) {
        throw new Error(`Failed to load data package: ${response.status} ${response.url}`);
    }

    const reader = response.body.getReader();
    let receivedLength = 0;
    let chunks = [];
    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        chunks.push(value);
        receivedLength += value.length;
        if (typeof setStatus === "function") {
            setStatus(`Downloading...(${receivedLength}/${dataSize})`);
        }
    }
    let buffer = new Uint8Array(receivedLength);
    let position = 0;
    for (let chunk of chunks) {
        buffer.set(chunk, position);
        position += chunk.length;
    }
    return new Uint8Array(buffer.buffer);
};

async function startGame(e) {
    e.stopPropagation();
    await resumeAudioContexts();

    document.querySelector('.start-container').style.display = 'none';
    document.querySelector('.disclaimer').style.display = 'none';
    document.querySelector('.developed-by').style.display = 'none';

    const intro = document.querySelector('.intro');
    const introContainer = document.querySelector('.intro-container');
    const loaderContainer = document.querySelector('.loader-container');
    document.querySelector('.click-to-play').style.display = 'none';
    loaderContainer.style.display = "flex";
    introContainer.hidden = false;
    intro.play();

    const dataBuffer = await loadData();
    spinnerElement.hidden = true;
    setStatus(t("clickToContinue"));
    introContainer.hidden = false;
    introContainer.style.cursor = 'pointer';
    const clickHandler = () => {
        resumeAudioContexts();
        intro.pause();
        introContainer.style.display = 'none';
        loadGame(dataBuffer);
    };
    if (isMobile) {
        window.addEventListener('pointerup', clickHandler, { once: true });
    } else {
        window.addEventListener('click', clickHandler, { once: true });
    }
}

function setStatus(text) {
    if (!text) {
        progressElement.hidden = true;
        spinnerElement.hidden = true;
        return;
    }
    const match = text.match(/(.+)\((\d+\.?\d*)\/(\d+)\)/);
    if (match) {
        const [current, total] = match.slice(2, 4).map(Number);
        const percent = (current / total * 100).toFixed(0);
        statusElement.textContent = t("downloading") + ` ${percent}%`;
        progressElement.value = current;
        progressElement.max = total;
        progressElement.hidden = false;
        spinnerElement.hidden = false;
        const progressBarFill = spinnerElement.querySelector('.progress-bar-fill');
        if (progressBarFill) {
            progressBarFill.style.width = percent + '%';
        }
    } else {
        statusElement.textContent = text;
    }
};

async function loadGame(data) {
    var Module = {
        mainCalled: () => {
            try {
                Module.FS.unlink("/vc-assets/local/revc.ini");
                Module.FS.createDataFile("/vc-assets/local/revc.ini", 0, revc_ini, revc_ini.length);
            } catch (e) {
                console.error('mainCalled error:', e);
            }
        },
        syncRevcIni: () => {
            try {
                const path = Module.FS.lookupPath("/vc-assets/local/revc.ini");
                if (path && path.node && path.node.contents) {
                    localStorage.setItem('vcsky.revc.ini', textDecoder.decode(path.node.contents));
                }
            } catch (e) {
                console.error('syncRevcIni error:', e);
            }
        },
        preRun: [],
        postRun: [],
        print: (...args) => console.log(args.join(' ')),
        printErr: (...args) => console.error(args.join(' ')),
        getPreloadedPackage: () => {
            return data.buffer;
        },
        canvas: function () {
            const canvas = document.getElementById('canvas');
            canvas.addEventListener('webglcontextlost', (e) => {
                statusElement.textContent = 'WebGL context lost. Please reload the page.';
                e.preventDefault();
            });
            canvas.addEventListener('pointerdown', () => {
                resumeAudioContexts();
            });
            return canvas;
        }(),
        setStatus,
        totalDependencies: 0,
        monitorRunDependencies: (num) => {
            Module.totalDependencies = Math.max(Module.totalDependencies, num);
            Module.setStatus(`Preparing... (${Module.totalDependencies - num}/${Module.totalDependencies})`);
        },
        hotelMission: () => {
        },
    };
    Module.log = Module.print;
    Module.instantiateWasm = async (
        info,
        receiveInstance,
    ) => {
        const wasm = await (await fetch(wasm_content ? wasm_content : "index.wasm")).arrayBuffer();
        const module = await WebAssembly.instantiate(wasm, info);
        return receiveInstance(module.instance, module);
    };
    window.onerror = (message) => {
        Module.setStatus(`Error: ${message}`);
        spinnerElement.hidden = true;
    };
    Module.arguments = window.location.search
        .slice(1)
        .split('&')
        .filter(Boolean)
        .map(decodeURIComponent);
    window.onbeforeunload = function (event) {
        event.preventDefault();
        return '';
    };

    window.Module = Module;
    const script = document.createElement('script');
    script.async = true;
    script.addEventListener('load', () => {
        resumeAudioContexts();
    });
    script.src = 'index.js';
    document.body.appendChild(script);

    document.body.classList.add('gameIsStarted');

    const emulator = new GamepadEmulator();
    const gamepad = emulator.AddEmulatedGamepad(null, true);
    const gamepadEmulatorConfig = {
        directions: { up: true, down: true, left: true, right: true },
        dragDistance: 100,
        tapTarget: move,
        lockTargetWhilePressed: true,
        xAxisIndex: 0,
        yAxisIndex: 1,
        swapAxes: false,
        invertX: false,
        invertY: false,
    };
    emulator.AddDisplayJoystickEventListeners(0, [gamepadEmulatorConfig]);
    const gamepadEmulatorConfig1 = {
        directions: { up: true, down: true, left: true, right: true },
        dragDistance: 100,
        tapTarget: look,
        lockTargetWhilePressed: true,
        xAxisIndex: 2,
        yAxisIndex: 3,
        swapAxes: false,
        invertX: false,
        invertY: false,
    };
    emulator.AddDisplayJoystickEventListeners(0, [gamepadEmulatorConfig1]);

    emulator.AddDisplayButtonEventListeners(0, [{
        buttonIndex: 9,
        lockTargetWhilePressed: false,
        tapTarget: document.querySelector('.touch-control.menu'),
    }]);
    emulator.AddDisplayButtonEventListeners(0, [{
        buttonIndex: 3,
        lockTargetWhilePressed: false,
        tapTarget: document.querySelector('.touch-control.car.getIn'),
    }]);
    emulator.AddDisplayButtonEventListeners(0, [{
        buttonIndex: 0,
        lockTargetWhilePressed: false,
        tapTarget: document.querySelector('.touch-control.run'),
    }]);
    emulator.AddDisplayButtonEventListeners(0, [{
        buttonIndex: 1,
        lockTargetWhilePressed: false,
        tapTarget: document.querySelector('.touch-control.fist'),
    }]);
    emulator.AddDisplayButtonEventListeners(0, [{
        buttonIndex: 5,
        lockTargetWhilePressed: false,
        tapTarget: document.querySelector('.touch-control.drift'),
    }]);
    emulator.AddDisplayButtonEventListeners(0, [{
        buttonIndex: 2,
        lockTargetWhilePressed: false,
        tapTarget: document.querySelector('.touch-control.jump'),
    }]);
    emulator.AddDisplayButtonEventListeners(0, [{
        buttonIndex: 4,
        lockTargetWhilePressed: false,
        tapTarget: document.querySelector('.touch-control.mobile'),
    }]);
    emulator.AddDisplayButtonEventListeners(0, [{
        buttonIndex: 11,
        lockTargetWhilePressed: false,
        tapTarget: document.querySelector('.touch-control.job'),
    }]);
    emulator.AddDisplayButtonEventListeners(0, [{
        buttonIndex: 4,
        lockTargetWhilePressed: false,
        tapTarget: document.querySelector('.touch-control.radio'),
    }]);
    emulator.AddDisplayButtonEventListeners(0, [{
        buttonIndex: 7,
        lockTargetWhilePressed: false,
        tapTarget: document.querySelector('.touch-control.weapon'),
    }]);
    emulator.AddDisplayButtonEventListeners(0, [{
        buttonIndex: 8,
        lockTargetWhilePressed: false,
        tapTarget: document.querySelector('.touch-control.camera'),
    }]);
    emulator.AddDisplayButtonEventListeners(0, [{
        buttonIndex: 10,
        lockTargetWhilePressed: false,
        tapTarget: document.querySelector('.touch-control.horn'),
    }]);
    emulator.AddDisplayButtonEventListeners(0, [{
        buttonIndex: 7,
        buttonIndexes: [1, 7],
        lockTargetWhilePressed: false,
        tapTarget: document.querySelector('.touch-control.fireRight'),
    }]);
    emulator.AddDisplayButtonEventListeners(0, [{
        buttonIndex: 6,
        buttonIndexes: [1, 6],
        lockTargetWhilePressed: false,
        tapTarget: document.querySelector('.touch-control.fireLeft'),
    }]);
}

const clickToPlay = document.querySelector('.click-to-play');
const clickLink = clickToPlay.querySelector('button');
clickToPlay.addEventListener('click', (e) => {
    if (clickLink.disabled || window.__gtaGameReady !== true) {
        return;
    }
    if (e.target === clickToPlay || e.target === clickLink) {
        startGame(e);
    }
});

const savesMountPoint = "/vc-assets/local/userfiles";
const savesFile = "vcsky.saves";
wrapIDBFS(console.log).addListener({
    onLoad: (_, mount) => {
        if (mount.mountpoint !== savesMountPoint) {
            return null;
        }
        const token = localStorage.getItem('vcsky.key');
        if (token && token.length === 5) {
            const promise = CloudSDK.pullFromStorage(token, savesFile);
            promise.then((payload) => {
                console.log('[IDBFS] onLoad', token, payload ? payload.length / 1024 : 0, 'kb');
            });
            return promise;
        }
        return null;
    },
    onSave: (getData, _, mount) => {
        if (mount.mountpoint !== savesMountPoint) {
            return;
        }
        const token = localStorage.getItem('vcsky.key');
        if (token && token.length === 5) {
            getData().then((payload) => {
                if (payload.length > 0) {
                    console.log('[IDBFS] onSave', token, payload.length / 1024, 'kb');
                    return CloudSDK.pushToStorage(token, savesFile, payload);
                }
            });
        }
    },
});


function updateToken(token) {
    if (!cloudSavesStatus || !keyStatus) {
        return;
    }
    cloudSavesStatus.textContent = t('checking');
    if (token.length === 5) {
        CloudSDK.resolveToken(token).then((profile) => {
            if (profile) {
                console.log('[CloudSdk] resolveToken', profile);
                localStorage.setItem('vcsky.key', profile.token);
                if (profile.premium) {
                    keyStatus.textContent = t('enabled');
                    keyStatus.style.color = 'green';
                    keyStatus.style.fontWeight = 'bold';
                } else {
                    keyStatus.textContent = t('disabled');
                    keyStatus.style.color = 'red';
                    keyStatus.style.fontWeight = 'bold';
                }
            } else {
                keyStatus.textContent = t('invalidKey');
                keyStatus.style.color = 'white';
                keyStatus.style.fontWeight = 'normal';
            }
        });
    } else {
        cloudSavesStatus.textContent = t('enterKey');
    }
}

const keyInput = document.querySelector('.jsdos-key-input');
const keyStatus = document.querySelector('.jsdos-key-status');
if (keyInput && keyStatus) {
    keyInput.setAttribute('placeholder', t("enterJsDosKey"));
    keyInput.addEventListener('paste', (e) => {
        setTimeout(() => {
            updateToken(e.target.value);
        }, 100);
    });

    keyInput.addEventListener('keyup', (e) => {
        updateToken(e.target.value);
    });

    if (localStorage.getItem('vcsky.key')) {
        keyInput.value = localStorage.getItem('vcsky.key');
        updateToken(keyInput.value);
    } else {
        keyStatus.textContent = t('invalidKey');
        keyStatus.style.color = 'shite';
        keyStatus.style.fontWeight = 'normal';
    }
}

const clickToPlayButton = document.getElementById('click-to-play-button');
clickToPlayButton.textContent = t('clickToPlay');
if (!window.__gtaGameReady) {
    clickToPlayButton.classList.add('disabled');
    clickToPlayButton.disabled = true;
}
const cloudSavesLink = document.getElementById('cloud-saves-link');
if (cloudSavesLink) cloudSavesLink.textContent = t('cloudSaves');
if (cloudSavesStatus) cloudSavesStatus.textContent = t('enterKey');
const disclaimerText = document.getElementById('disclaimer-text');
disclaimerText.textContent = t('disclaimer');
const disclaimerSources = document.getElementById('disclaimer-sources');
disclaimerSources.textContent = t('disclaimerSources');
const developedBy = document.querySelector('.developed-by');
const ruTranslate = t('ruTranslate');
if (ruTranslate) developedBy.innerHTML += ruTranslate;
const portBy = document.getElementById('port-by');
if (portBy) portBy.textContent = t('portBy');

function showWasted() {
    const wastedContainer = document.querySelector('.wasted-container');
    wastedContainer.hidden = false;
}

const revc_iniDefault = `
[VideoMode]
Width=800
Height=600
Depth=32
Subsystem=0
Windowed=0
[Controller]
HeadBob1stPerson=0
HorizantalMouseSens=0.002500
InvertMouseVertically=1
DisableMouseSteering=1
Vibration=0
Method=${isTouch ? '1' : '0'}
InvertPad=0
JoystickName=
PadButtonsInited=0
[Audio]
SfxVolume=36
MusicVolume=37
MP3BoostVolume=0
Radio=0
SpeakerType=0
Provider=0
DynamicAcoustics=1
[Display]
Brightness=256
DrawDistance=1.800000
Subtitles=0
ShowHud=1
RadarMode=0
ShowLegends=0
PedDensity=1.200000
CarDensity=1.200000
CutsceneBorders=1
FreeCam=0
[Graphics]
AspectRatio=0
VSync=1
Trails=1
FrameLimiter=0
MultiSampling=0
IslandLoading=0
PS2AlphaTest=1
ColourFilter=2
MotionBlur=0
VehiclePipeline=0
NeoRimLight=0
NeoLightMaps=0
NeoRoadGloss=0
[General]
SkinFile=$$""
Language=0
DrawVersionText=0
NoMovies=0
[CustomPipesValues]
PostFXIntensity=1.000000
NeoVehicleShininess=1.000000
NeoVehicleSpecularity=1.000000
RimlightMult=1.000000
LightmapMult=1.000000
GlossMult=1.000000
[Rendering]
BackfaceCulling=1
NewRenderer=1
[Draw]
ProperScaling=1
FixRadar=1
FixSprites=1
[Bindings]
PED_FIREWEAPON=mouse:LEFT,2ndKbd:PAD5
PED_CYCLE_WEAPON_RIGHT=2ndKbd:PADENTER,mouse:WHLDOWN,kbd:E
PED_CYCLE_WEAPON_LEFT=kbd:PADDEL,mouse:WHLUP,2ndKbd:Q
GO_FORWARD=kbd:UP,2ndKbd:W
GO_BACK=kbd:DOWN,2ndKbd:S
GO_LEFT=2ndKbd:A,kbd:LEFT
GO_RIGHT=kbd:RIGHT,2ndKbd:D
PED_SNIPER_ZOOM_IN=kbd:PGUP,2ndKbd:Z,mouse:WHLUP
PED_SNIPER_ZOOM_OUT=kbd:PGDN,2ndKbd:X,mouse:WHLDOWN
VEHICLE_ENTER_EXIT=kbd:ENTER,2ndKbd:F
CAMERA_CHANGE_VIEW_ALL_SITUATIONS=kbd:HOME,2ndKbd:V
PED_JUMPING=kbd:RCTRL,2ndKbd:SPC
PED_SPRINT=2ndKbd:LSHIFT,kbd:RSHIFT
PED_LOOKBEHIND=2ndKbd:CAPSLK,mouse:MIDDLE,kbd:PADINS
PED_DUCK=kbd:C
PED_ANSWER_PHONE=kbd:TAB
VEHICLE_FIREWEAPON=kbd:PADINS,2ndKbd:LCTRL,mouse:LEFT
VEHICLE_ACCELERATE=2ndKbd:W
VEHICLE_BRAKE=2ndKbd:S
VEHICLE_CHANGE_RADIO_STATION=kbd:INS,2ndKbd:R
VEHICLE_HORN=2ndKbd:LSHIFT,kbd:RSHIFT
TOGGLE_SUBMISSIONS=kbd:PLUS,2ndKbd:CAPSLK
VEHICLE_HANDBRAKE=kbd:RCTRL,2ndKbd:SPC,mouse:RIGHT
PED_1RST_PERSON_LOOK_LEFT=kbd:PADLEFT
PED_1RST_PERSON_LOOK_RIGHT=kbd:PADHOME
VEHICLE_LOOKLEFT=kbd:PADEND,2ndKbd:Q
VEHICLE_LOOKRIGHT=kbd:PADDOWN,2ndKbd:E
VEHICLE_LOOKBEHIND=mouse:MIDDLE
VEHICLE_TURRETLEFT=kbd:PADLEFT
VEHICLE_TURRETRIGHT=kbd:PAD5
VEHICLE_TURRETUP=kbd:PADPGUP,2ndKbd:UP
VEHICLE_TURRETDOWN=kbd:PADRIGHT,2ndKbd:DOWN
PED_CYCLE_TARGET_LEFT=kbd:[,2ndKbd:PADEND
PED_CYCLE_TARGET_RIGHT=2ndKbd:],kbd:PADDOWN
PED_CENTER_CAMERA_BEHIND_PLAYER=kbd:#
PED_LOCK_TARGET=kbd:DEL,mouse:RIGHT,2ndKbd:PADRIGHT
NETWORK_TALK=kbd:T
PED_1RST_PERSON_LOOK_UP=kbd:PADPGUP
PED_1RST_PERSON_LOOK_DOWN=kbd:PADUP
_CONTROLLERACTION_36=
TOGGLE_DPAD=
SWITCH_DEBUG_CAM_ON=
TAKE_SCREEN_SHOT=
SHOW_MOUSE_POINTER_TOGGLE=
UNKNOWN_ACTION=

`;

const revc_ini = (() => {
    const cached = localStorage.getItem('vcsky.revc.ini');
    if (cached) {
        return cached;
    }
    return revc_iniDefault;
})();

// Configurable mode UI
if (configurableMode) {
    const configPanel = document.getElementById('config-panel');
    const configLang = document.getElementById('config-lang');
    const configCheats = document.getElementById('config-cheats');
    const configFullscreen = document.getElementById('config-fullscreen');
    const configMaxFps = document.getElementById('config-max-fps');
    
    if (configPanel && configCheats && configFullscreen && configMaxFps) {
        // Show config panel
        configPanel.style.display = 'block';
        
        // Set initial values from URL params
        if (configLang) configLang.value = currentLanguage;
        configCheats.checked = cheatsEnabled;
        configFullscreen.checked = autoFullScreen;
        configMaxFps.value = maxFPS;
        
        // Update config panel labels with current language
        updateAllTranslations();
        
        // Language selector handler
        if (configLang) {
            configLang.addEventListener('change', (e) => {
                currentLanguage = e.target.value;
                updateGameDataForLanguage(currentLanguage);
                updateAllTranslations();
            });
        }
        
        // Update settings when changed
        configCheats.addEventListener('change', (e) => {
            cheatsEnabled = e.target.checked;
        });
        
        configFullscreen.addEventListener('change', (e) => {
            autoFullScreen = e.target.checked;
        });
        
        configMaxFps.addEventListener('input', (e) => {
            maxFPS = parseInt(e.target.value) || 0;
        });
    }
}
