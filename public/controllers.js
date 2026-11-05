(() => {
    const nativeGamepads = navigator.getGamepads?.bind(navigator);
    const button = document.getElementById('connect-controller');
    const status = document.getElementById('controller-status');
    let device, driver, emulator, virtualPad, lastReport;
    let connected = false;

    const axis = (value, center) => (value - center) / (value < center ? center : center - 1);
    function dpad(buttons, hat) {
        buttons[12] = Number(hat === 0 || hat === 1 || hat === 7);
        buttons[13] = Number(hat >= 3 && hat <= 5);
        buttons[14] = Number(hat >= 5 && hat <= 7);
        buttons[15] = Number(hat >= 1 && hat <= 3);
    }

    function xbox(reportId, data) {
        if (reportId !== 1 || data.byteLength !== 16) return;
        const axes = Array.from({ length: 4 }, (_, i) => axis(data.getUint16(i * 2, true), 32768));
        const buttons = Array(17).fill(0);
        const bits = data.getUint16(13, true);
        [0, 1, 3, 4, 6, 7].forEach((bit, i) => { buttons[i] = (bits >> bit) & 1; });
        buttons[6] = (data.getUint16(8, true) & 1023) / 1023;
        buttons[7] = (data.getUint16(10, true) & 1023) / 1023;
        [10, 11, 13, 14].forEach((bit, i) => { buttons[i + 8] = (bits >> bit) & 1; });
        buttons[16] = (bits >> 12) & 1;
        dpad(buttons, (data.getUint8(12) & 15) - 1);
        return { axes, buttons };
    }

    // Sony report layouts: SDL_hidapi_ps4.c / SDL_hidapi_ps5.c (libsdl-org/SDL).
    function playstation(reportId, data, dualSense) {
        let offset = 0, buttonsOffset = 4, triggersOffset = 7;
        if (dualSense) {
            if (reportId === 0x31 && data.byteLength === 77) offset = 1;
            else if (reportId !== 1 || ![9, 63, 77].includes(data.byteLength)) return;
            if (reportId === 0x31 || data.byteLength === 63) {
                buttonsOffset = 7;
                triggersOffset = 4;
            }
        } else {
            if (reportId === 0x11 && data.byteLength === 77) offset = 2;
            else if (reportId !== 1 || ![9, 63].includes(data.byteLength)) return;
        }
        const axes = Array.from({ length: 4 }, (_, i) => axis(data.getUint8(offset + i), 128));
        const face = data.getUint8(offset + buttonsOffset);
        const controls = data.getUint8(offset + buttonsOffset + 1);
        const buttons = Array(17).fill(0);
        [5, 6, 4, 7].forEach((bit, i) => { buttons[i] = (face >> bit) & 1; });
        buttons[4] = controls & 1;
        buttons[5] = (controls >> 1) & 1;
        buttons[6] = data.getUint8(offset + triggersOffset) / 255 || ((controls >> 2) & 1);
        buttons[7] = data.getUint8(offset + triggersOffset + 1) / 255 || ((controls >> 3) & 1);
        [4, 5, 6, 7].forEach((bit, i) => { buttons[i + 8] = (controls >> bit) & 1; });
        buttons[16] = data.getUint8(offset + buttonsOffset + 2) & 1;
        dpad(buttons, face & 15);
        return { axes, buttons };
    }

    const drivers = [
        { vendorId: 0x045e, products: [0x0b13], decode: xbox },
        { vendorId: 0x054c, products: [0x05c4, 0x09cc], decode: (id, data) => playstation(id, data, false) },
        { vendorId: 0x054c, products: [0x0ce6, 0x0df2], decode: (id, data) => playstation(id, data, true) },
    ];
    const findDriver = candidate => drivers.find(entry => entry.vendorId === candidate.vendorId && entry.products.includes(candidate.productId));
    function nativePad() {
        try { return Array.from(nativeGamepads?.() || []).find(pad => pad?.connected); }
        catch { return null; }
    }
    function show(key, options) {
        if (!status) return;
        status.dataset.state = key === 'controller.connected' ? 'ok' : ['controller.failed', 'controller.permissionDenied', 'controller.unsupported'].includes(key) ? 'error' : '';
        window.vcI18n.setText(status, key, options);
    }
    function connectionFailed(error) {
        if (error.name === 'NotFoundError') { updateStatus(); return; }
        const key = error.message === 'controller.unsupported' ? 'controller.unsupported' :
            ['NotAllowedError', 'SecurityError'].includes(error.name) ? 'controller.permissionDenied' : 'controller.failed';
        show(key);
    }
    function updateStatus() {
        const name = connected ? device.productName : nativePad()?.id;
        if (button) button.disabled = !!name;
        show(name ? 'controller.connected' : navigator.hid ? 'controller.idle' : 'controller.nativeOnly', { name });
    }
    function release() {
        if (!virtualPad) return;
        for (let i = 0; i < 4; i++) emulator.MoveAxis(0, i, 0);
        for (let i = 0; i < 17; i++) emulator.PressButton(0, i, 0, false);
    }
    function apply() {
        if (!emulator || !connected) return;
        if (!virtualPad) { emulator.AddEmulatedGamepad(0, true); virtualPad = true; }
        if (!document.hasFocus() || document.hidden) { release(); return; }
        if (!lastReport) return;
        lastReport.axes.forEach((value, i) => emulator.MoveAxis(0, i, value));
        lastReport.buttons.forEach((value, i) => emulator.PressButton(0, i, value, value > 0));
    }
    function readReport({ reportId, data }) {
        const report = driver.decode(reportId, data);
        if (report) { lastReport = report; apply(); }
    }
    async function open(candidate) {
        const selected = findDriver(candidate);
        if (!selected) throw new Error('controller.unsupported');
        if (!candidate.opened) await candidate.open();
        device?.removeEventListener('inputreport', readReport);
        device = candidate;
        driver = selected;
        lastReport = null;
        connected = true;
        device.addEventListener('inputreport', readReport);
        apply();
        updateStatus();
    }
    window.vcController = {
        get connected() { return connected || !!nativePad(); },
        attach(target) { emulator = target; apply(); },
        async connect(requestAccess = false) {
            if (connected || !navigator.hid || nativePad()) { updateStatus(); return; }
            try {
                let candidate = (await navigator.hid.getDevices()).find(findDriver);
                if (!candidate && requestAccess) {
                    const filters = drivers.flatMap(entry => entry.products.map(productId => ({ vendorId: entry.vendorId, productId })));
                    [candidate] = await navigator.hid.requestDevice({ filters });
                }
                if (candidate) await open(candidate);
                else updateStatus();
            } catch (error) { connectionFailed(error); }
        },
    };
    navigator.hid?.addEventListener('disconnect', event => {
        if (event.device !== device) return;
        connected = false;
        lastReport = null;
        release();
        updateStatus();
    });
    navigator.hid?.addEventListener('connect', event => {
        if (!connected && device && event.device.vendorId === device.vendorId && event.device.productId === device.productId) {
            open(event.device).catch(connectionFailed);
        }
    });
    window.addEventListener('gamepadconnected', updateStatus);
    window.addEventListener('gamepaddisconnected', updateStatus);
    window.addEventListener('blur', release);
    window.addEventListener('focus', apply);
    document.addEventListener('visibilitychange', () => document.hidden ? release() : apply());
    if (button) {
        button.hidden = !navigator.hid;
        button.addEventListener('click', async () => {
            button.disabled = true;
            show('controller.connecting');
            try { await window.vcController.connect(true); }
            finally { button.disabled = connected || !!nativePad(); }
        });
    }
    updateStatus();
})();
