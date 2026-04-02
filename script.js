const imageLoader = document.getElementById('imageLoader');
const mainCanvas = document.getElementById('imageCanvas');
const mainCtx = mainCanvas.getContext('2d', { willReadFrequently: true });

const gridCanvas = document.getElementById('gridCanvas');
const gridCtx = gridCanvas.getContext('2d');

const selectionCanvas = document.getElementById('selectionCanvas');
const selectionCtx = selectionCanvas.getContext('2d');

const offscreenMaskCanvas = document.createElement('canvas');
const offscreenMaskCtx = offscreenMaskCanvas.getContext('2d', { willReadFrequently: true });

const canvasContainer = document.querySelector('.canvas-container');
const crosshair = document.getElementById('crosshair');
const modeToggle = document.getElementById('mode-toggle');
const gridToggle = document.getElementById('grid-toggle');
const zoomOutBtn = document.getElementById('zoom-out-btn');

// Segmented Control Buttons
const modeCrosshairBtn = document.getElementById('mode-crosshair');
const modeRectBtn = document.getElementById('mode-rect');
const modeLassoBtn = document.getElementById('mode-lasso');

const resultCard = document.getElementById('result-card');
const hexDisplay = document.getElementById('hexValue');
const rgbDisplay = document.getElementById('rgbValue');
const swatch = document.getElementById('color-swatch');
const placeholderContent = document.getElementById('placeholderContent');
const btnText = document.getElementById('btnText');

const nativeColorInput = document.createElement('input');
nativeColorInput.type = 'color';
nativeColorInput.style.position = 'absolute';
nativeColorInput.style.opacity = '0';
nativeColorInput.style.width = '100%';
nativeColorInput.style.height = '100%';
nativeColorInput.style.top = '0';
nativeColorInput.style.left = '0';
nativeColorInput.style.border = 'none';
nativeColorInput.style.padding = '0';
nativeColorInput.style.margin = '0';
nativeColorInput.style.cursor = 'pointer';

swatch.style.position = 'relative';
swatch.style.overflow = 'hidden'; 
swatch.appendChild(nativeColorInput);

nativeColorInput.addEventListener('click', (e) => e.stopPropagation());
nativeColorInput.addEventListener('input', (e) => {
    const hex = e.target.value;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    updateDisplay(r, g, b);
});

let cachedImageData = null;
let currentHex = "";
let animationFrameId = null;
let transitionAnimationId = null; 
let calcThrottleId = null; 

let isDragging = false;
let isLocked = true;
let isGridOn = false;

// 0 = Individual Pixel, 1 = Rectangle Average, 2 = Lasso Average
let selectionMode = 0; 
let fitScale = 1;
let marchOffset = 0; 

let lastR = null, lastG = null, lastB = null;

let crosshairPos = { x: 0, y: 0 }; 
let dragStartTouch = { x: 0, y: 0 };
let dragStartCrosshair = { x: 0, y: 0 };

let marqueeRect = null; 
let marqueeResizeAction = null; 
let interactionStartImgPixel = { x: 0, y: 0 };
let interactionStartMarquee = null;

let lassoPoints = [];
let startLassoPoints = [];

let currentScale = 1;
let currentPanX = 0;
let currentPanY = 0;
let lastPinchDist = null;
let lastPinchCenter = null;
let lastPanTouch = null;

let placeholderInteractionTimeout = null;

function getNormalizedMarquee() {
    if (!marqueeRect) return null;
    return {
        minX: Math.max(0, Math.floor(Math.min(marqueeRect.x1, marqueeRect.x2))),
        maxX: Math.min(mainCanvas.width - 1, Math.floor(Math.max(marqueeRect.x1, marqueeRect.x2))),
        minY: Math.max(0, Math.floor(Math.min(marqueeRect.y1, marqueeRect.y2))),
        maxY: Math.min(mainCanvas.height - 1, Math.floor(Math.max(marqueeRect.y1, marqueeRect.y2)))
    };
}

function resizeGrid() {
    const rect = canvasContainer.getBoundingClientRect();
    gridCanvas.width = rect.width;
    gridCanvas.height = rect.height;
    selectionCanvas.width = rect.width;
    selectionCanvas.height = rect.height;
    if (cachedImageData) drawGrid();
}

window.addEventListener('resize', resizeGrid);

function clearDisplay() {
    currentHex = "";
    lastR = null; lastG = null; lastB = null;
    hexDisplay.textContent = "#------";
    rgbDisplay.textContent = "---, ---, ---";
    swatch.style.backgroundColor = "transparent";
    resultCard.classList.remove('active');
    nativeColorInput.value = "#000000";
}

modeToggle.addEventListener('click', () => {
    isLocked = !isLocked;
    updateUIState();
    updateZoomOutBtnVisibility();
});

gridToggle.addEventListener('click', () => {
    isGridOn = !isGridOn;
    if (isGridOn) {
        gridToggle.classList.add('active');
        mainCanvas.classList.add('pixelated');
    } else {
        gridToggle.classList.remove('active');
        mainCanvas.classList.remove('pixelated');
    }
    drawGrid();
});

function setSelectionMode(newMode) {
    if (selectionMode === newMode) return;
    selectionMode = newMode;
    
    // System Purge: Flush matrices and calculations
    marqueeRect = null;
    lassoPoints = [];
    startLassoPoints = [];
    if (calcThrottleId) {
        clearTimeout(calcThrottleId);
        calcThrottleId = null;
    }

    clearDisplay();

    if (selectionMode === 0 && cachedImageData) {
        // Auto-center individual crosshair fallback
        requestAnimationFrame(() => {
            const rect = mainCanvas.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            processCoordinates(centerX, centerY);
        });
    }
    
    updateUIState();
}

modeCrosshairBtn.addEventListener('click', () => setSelectionMode(0));
modeRectBtn.addEventListener('click', () => setSelectionMode(1));
modeLassoBtn.addEventListener('click', () => setSelectionMode(2));

function updateUIState() {
    // Segmented Control States
    modeCrosshairBtn.classList.toggle('active', selectionMode === 0);
    modeRectBtn.classList.toggle('active', selectionMode === 1);
    modeLassoBtn.classList.toggle('active', selectionMode === 2);

    // Lock Toggle States
    if (isLocked) {
        modeToggle.classList.remove('unlocked');
        modeToggle.classList.add('locked');
        crosshair.style.display = (selectionMode === 0) ? 'block' : 'none';
    } else {
        modeToggle.classList.remove('locked');
        modeToggle.classList.add('unlocked');
        crosshair.style.display = 'none';
    }
}

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

const triggerZoomReset = (e) => {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    if (transitionAnimationId) cancelAnimationFrame(transitionAnimationId);

    const startScale = currentScale;
    const startPanX = currentPanX;
    const startPanY = currentPanY;
    const duration = 250; 
    let startTime = null;

    const animateReset = (timestamp) => {
        if (!startTime) startTime = timestamp;
        const elapsed = timestamp - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const ease = easeOutCubic(progress);

        currentScale = startScale + (1 - startScale) * ease;
        currentPanX = startPanX + (0 - startPanX) * ease;
        currentPanY = startPanY + (0 - startPanY) * ease;

        applyTransform();
        if (progress < 1) transitionAnimationId = requestAnimationFrame(animateReset);
        else transitionAnimationId = null;
    };

    transitionAnimationId = requestAnimationFrame(animateReset);
};

zoomOutBtn.addEventListener('touchstart', triggerZoomReset, { passive: false });
zoomOutBtn.addEventListener('mousedown', triggerZoomReset);
zoomOutBtn.addEventListener('click', triggerZoomReset);

function handlePlaceholderTouchStart() { 
    if (placeholderInteractionTimeout) clearTimeout(placeholderInteractionTimeout);
    placeholderContent.classList.add('pressed'); 
}

function handlePlaceholderTouchEnd() { 
    placeholderInteractionTimeout = setTimeout(() => {
        placeholderContent.classList.remove('pressed'); 
    }, 200); 
}

placeholderContent.addEventListener('touchstart', handlePlaceholderTouchStart, {passive: true});
placeholderContent.addEventListener('mousedown', handlePlaceholderTouchStart);
['touchend', 'mouseup', 'mouseleave', 'touchcancel'].forEach(evt => {
    placeholderContent.addEventListener(evt, handlePlaceholderTouchEnd);
});

placeholderContent.addEventListener('click', () => imageLoader.click());
imageLoader.addEventListener('click', function() { this.value = null; });
imageLoader.addEventListener('change', handleImage, false);

function clampPan() {
    const rect = canvasContainer.getBoundingClientRect();
    const scaledWidth = mainCanvas.offsetWidth * currentScale;
    const scaledHeight = mainCanvas.offsetHeight * currentScale;

    const maxPanX = Math.max(0, (scaledWidth - rect.width) / 2);
    const maxPanY = Math.max(0, (scaledHeight - rect.height) / 2);

    currentPanX = Math.max(-maxPanX, Math.min(maxPanX, currentPanX));
    currentPanY = Math.max(-maxPanY, Math.min(maxPanY, currentPanY));
}

function updateZoomOutBtnVisibility() {
    if (!isLocked && currentScale > 1.01) {
        zoomOutBtn.classList.add('visible');
        if (cachedImageData) {
            const btnRect = zoomOutBtn.getBoundingClientRect();
            const targetX = btnRect.left + btnRect.width / 2;
            const targetY = btnRect.top + btnRect.height / 2;

            const rect = mainCanvas.getBoundingClientRect();
            if (targetX >= rect.left && targetX <= rect.right && targetY >= rect.top && targetY <= rect.bottom) {
                const scaleX = mainCanvas.width / rect.width;
                const scaleY = mainCanvas.height / rect.height;
                const x = Math.floor((targetX - rect.left) * scaleX);
                const y = Math.floor((targetY - rect.top) * scaleY);
                
                if (x >= 0 && y >= 0 && x < mainCanvas.width && y < mainCanvas.height) {
                    const index = (y * mainCanvas.width + x) * 4;
                    const r = cachedImageData[index];
                    const g = cachedImageData[index + 1];
                    const b = cachedImageData[index + 2];
                    const luminance = (0.2126 * r) + (0.7152 * g) + (0.0722 * b);
                    zoomOutBtn.style.color = luminance >= 128 ? '#000000' : '#ffffff';
                    return;
                }
            }
        }
        zoomOutBtn.style.color = 'var(--text)';
    } else {
        zoomOutBtn.classList.remove('visible');
    }
}

function drawGrid() {
    gridCtx.clearRect(0, 0, gridCanvas.width, gridCanvas.height);
    
    const trueScale = fitScale * currentScale;
    if (!isGridOn || trueScale < 4 || !cachedImageData) return;

    const cw = gridCanvas.width;
    const ch = gridCanvas.height;
    const sw = mainCanvas.width * trueScale;
    const sh = mainCanvas.height * trueScale;

    const imgLeft = (cw / 2) - (sw / 2) + currentPanX;
    const imgTop = (ch / 2) - (sh / 2) + currentPanY;

    gridCtx.beginPath();
    gridCtx.strokeStyle = "rgba(128,128,128,0.5)"; 
    gridCtx.lineWidth = 1;

    const startX = Math.max(0, imgLeft);
    const endX = Math.min(cw, imgLeft + sw);
    const startY = Math.max(0, imgTop);
    const endY = Math.min(ch, imgTop + sh);

    const startCol = Math.ceil((startX - imgLeft) / trueScale);
    const endCol = Math.floor((endX - imgLeft) / trueScale);

    for (let i = startCol; i <= endCol; i++) {
        const x = imgLeft + i * trueScale;
        const snappedX = Math.floor(x) + 0.5; 
        gridCtx.moveTo(snappedX, startY);
        gridCtx.lineTo(snappedX, endY);
    }

    const startRow = Math.ceil((startY - imgTop) / trueScale);
    const endRow = Math.floor((endY - imgTop) / trueScale);

    for (let i = startRow; i <= endRow; i++) {
        const y = imgTop + i * trueScale;
        const snappedY = Math.floor(y) + 0.5;
        gridCtx.moveTo(startX, snappedY);
        gridCtx.lineTo(endX, snappedY);
    }

    gridCtx.stroke();
}

function drawSelectionBorders() {
    selectionCtx.clearRect(0, 0, selectionCanvas.width, selectionCanvas.height);
    
    if (selectionMode === 0) return;
    if (selectionMode === 1 && !marqueeRect) return;
    if (selectionMode === 2 && lassoPoints.length < 2) return;

    const cw = selectionCanvas.width;
    const ch = selectionCanvas.height;
    const trueScale = fitScale * currentScale;
    const sw = mainCanvas.width * trueScale;
    const sh = mainCanvas.height * trueScale;

    const imgLeft = (cw / 2) - (sw / 2) + currentPanX;
    const imgTop = (ch / 2) - (sh / 2) + currentPanY;

    selectionCtx.beginPath();

    if (selectionMode === 1) { 
        const norm = getNormalizedMarquee();
        if (!norm) return;
        const x = imgLeft + norm.minX * trueScale;
        const y = imgTop + norm.minY * trueScale;
        const w = (norm.maxX - norm.minX + 1) * trueScale;
        const h = (norm.maxY - norm.minY + 1) * trueScale;
        selectionCtx.rect(x, y, w, h);
    } else if (selectionMode === 2) { 
        const getPt = (i) => ({
            x: imgLeft + lassoPoints[i].x * trueScale,
            y: imgTop + lassoPoints[i].y * trueScale
        });

        selectionCtx.moveTo(getPt(0).x, getPt(0).y);
        
        for (let i = 1; i < lassoPoints.length - 1; i++) {
            const p1 = getPt(i);
            const p2 = getPt(i + 1);
            const midX = (p1.x + p2.x) / 2;
            const midY = (p1.y + p2.y) / 2;
            selectionCtx.quadraticCurveTo(p1.x, p1.y, midX, midY);
        }
        if (lassoPoints.length > 1) {
            selectionCtx.lineTo(getPt(lassoPoints.length - 1).x, getPt(lassoPoints.length - 1).y);
        }
    }

    selectionCtx.closePath();
    selectionCtx.fillStyle = 'rgba(255, 255, 255, 0.15)';
    selectionCtx.fill();

    selectionCtx.lineCap = 'round';
    selectionCtx.lineJoin = 'round';

    // Base Layer: Solid Black Frame
    selectionCtx.lineWidth = 1.5;
    selectionCtx.strokeStyle = '#000000';
    selectionCtx.setLineDash([]);
    selectionCtx.stroke();

    // Top Layer: Marching Ants (Dashed White)
    selectionCtx.lineWidth = 1.5;
    selectionCtx.strokeStyle = '#ffffff';
    selectionCtx.setLineDash([6, 6]);
    selectionCtx.lineDashOffset = -marchOffset;
    selectionCtx.stroke();

    // Canvas-native Marquee interaction nodes
    if (selectionMode === 1 && isLocked && !isDragging) {
        const norm = getNormalizedMarquee();
        if (norm) {
            const x = imgLeft + norm.minX * trueScale;
            const y = imgTop + norm.minY * trueScale;
            const w = (norm.maxX - norm.minX + 1) * trueScale;
            const h = (norm.maxY - norm.minY + 1) * trueScale;

            selectionCtx.setLineDash([]);
            selectionCtx.fillStyle = '#ffffff';
            selectionCtx.strokeStyle = '#000000';
            selectionCtx.lineWidth = 1;
            
            const hw = 8; 
            const drawHandle = (hx, hy) => {
                selectionCtx.fillRect(hx - hw/2, hy - hw/2, hw, hw);
                selectionCtx.strokeRect(hx - hw/2, hy - hw/2, hw, hw);
            };

            drawHandle(x, y); drawHandle(x + w/2, y); drawHandle(x + w, y);
            drawHandle(x, y + h/2); drawHandle(x + w, y + h/2);
            drawHandle(x, y + h); drawHandle(x + w/2, y + h); drawHandle(x + w, y + h);
        }
    }
}

function renderLoop() {
    marchOffset += 0.5; 
    drawSelectionBorders();
    requestAnimationFrame(renderLoop);
}
requestAnimationFrame(renderLoop);

function applyTransform() {
    mainCanvas.style.transform = `translate(${currentPanX}px, ${currentPanY}px) scale(${currentScale})`;
    updateZoomOutBtnVisibility();
    drawGrid(); 
}

function handleImage(e) {
    if (!e.target.files[0]) return;
    const reader = new FileReader();
    
    reader.onload = function(event) {
        const img = new Image();
        img.onload = function() {
            placeholderContent.style.display = 'none';
            marqueeRect = null;
            lassoPoints = [];
            clearDisplay();
            
            let width = img.width;
            let height = img.height;

            resizeGrid();

            const containerRect = canvasContainer.getBoundingClientRect();
            fitScale = Math.min(containerRect.width / width, containerRect.height / height);
            mainCanvas.style.width = `${width * fitScale}px`;
            mainCanvas.style.height = `${height * fitScale}px`;

            mainCanvas.width = width;
            mainCanvas.height = height;
            mainCtx.imageSmoothingEnabled = false; 
            mainCtx.clearRect(0, 0, width, height); 
            mainCtx.drawImage(img, 0, 0, width, height);
            
            cachedImageData = mainCtx.getImageData(0, 0, width, height).data;
            
            currentScale = 1;
            currentPanX = 0;
            currentPanY = 0;
            applyTransform();
            
            requestAnimationFrame(() => {
                const rect = mainCanvas.getBoundingClientRect();
                const centerX = rect.left + rect.width / 2;
                const centerY = rect.top + rect.height / 2;
                if (selectionMode === 0) processCoordinates(centerX, centerY);
            });
            
            lastR = null; lastG = null; lastB = null;

            mainCanvas.classList.add('loaded');
            btnText.textContent = "Select New Photo";
            
            if (!isLocked) modeToggle.click(); 
            updateUIState();
        }
        img.src = event.target.result;
    }
    reader.readAsDataURL(e.target.files[0]);
}

function getClientCoords(e) {
    const clientX = e.changedTouches ? e.changedTouches[0].clientX : e.clientX;
    const clientY = e.changedTouches ? e.changedTouches[0].clientY : e.clientY;
    return { x: clientX, y: clientY };
}

function screenToImageCoordsFloat(screenX, screenY) {
    const rect = mainCanvas.getBoundingClientRect();
    const scaleX = mainCanvas.width / rect.width;
    const scaleY = mainCanvas.height / rect.height;
    return {
        x: (screenX - rect.left) * scaleX,
        y: (screenY - rect.top) * scaleY
    };
}

function getMarqueeHitAction(floatImgX, floatImgY) {
    const norm = getNormalizedMarquee();
    if (!norm) return 'new';
    
    const rect = mainCanvas.getBoundingClientRect();
    const hitZoneScale = mainCanvas.width / rect.width;
    const threshold = 15 * hitZoneScale; 

    const rightEdge = norm.maxX + 1;
    const bottomEdge = norm.maxY + 1;

    const nearLeft = Math.abs(floatImgX - norm.minX) <= threshold;
    const nearRight = Math.abs(floatImgX - rightEdge) <= threshold;
    const nearTop = Math.abs(floatImgY - norm.minY) <= threshold;
    const nearBottom = Math.abs(floatImgY - bottomEdge) <= threshold;

    if (nearTop && nearLeft) return 'nw';
    if (nearTop && nearRight) return 'ne';
    if (nearBottom && nearLeft) return 'sw';
    if (nearBottom && nearRight) return 'se';
    
    if (nearTop && floatImgX >= norm.minX && floatImgX <= rightEdge) return 'n';
    if (nearBottom && floatImgX >= norm.minX && floatImgX <= rightEdge) return 's';
    if (nearLeft && floatImgY >= norm.minY && floatImgY <= bottomEdge) return 'w';
    if (nearRight && floatImgY >= norm.minY && floatImgY <= bottomEdge) return 'e';

    if (floatImgX >= norm.minX && floatImgX <= rightEdge && floatImgY >= norm.minY && floatImgY <= bottomEdge) return 'move';

    return 'new';
}

function isPointInLassoPoly(pt) {
    if (lassoPoints.length < 3) return false;
    let inside = false;
    for (let i = 0, j = lassoPoints.length - 1; i < lassoPoints.length; j = i++) {
        let xi = lassoPoints[i].x, yi = lassoPoints[i].y;
        let xj = lassoPoints[j].x, yj = lassoPoints[j].y;
        let intersect = ((yi > pt.y) != (yj > pt.y)) && (pt.x < (xj - xi) * (pt.y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

function triggerAverageCalculation() {
    if (calcThrottleId) clearTimeout(calcThrottleId);
    calcThrottleId = setTimeout(() => {
        if (selectionMode === 1) calculateAverageRectCore();
        if (selectionMode === 2) calculateAverageLassoCore();
    }, 50); 
}

function calculateAverageRectCore() {
    const norm = getNormalizedMarquee();
    if (!norm) return;

    let rSum = 0, gSum = 0, bSum = 0, count = 0;

    for (let y = norm.minY; y <= norm.maxY; y++) {
        for (let x = norm.minX; x <= norm.maxX; x++) {
            const index = (y * mainCanvas.width + x) * 4;
            rSum += cachedImageData[index];
            gSum += cachedImageData[index + 1];
            bSum += cachedImageData[index + 2];
            count++;
        }
    }

    if (count > 0) updateDisplay(Math.round(rSum/count), Math.round(gSum/count), Math.round(bSum/count));
}

function calculateAverageLassoCore() {
    if (lassoPoints.length < 3) return;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let p of lassoPoints) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
    }

    minX = Math.max(0, Math.floor(minX));
    maxX = Math.min(mainCanvas.width - 1, Math.ceil(maxX));
    minY = Math.max(0, Math.floor(minY));
    maxY = Math.min(mainCanvas.height - 1, Math.ceil(maxY));

    const width = maxX - minX + 1;
    const height = maxY - minY + 1;
    if (width <= 0 || height <= 0) return;

    offscreenMaskCanvas.width = width;
    offscreenMaskCanvas.height = height;
    offscreenMaskCtx.clearRect(0, 0, width, height);

    offscreenMaskCtx.beginPath();
    for (let i = 0; i < lassoPoints.length; i++) {
        const px = lassoPoints[i].x - minX;
        const py = lassoPoints[i].y - minY;
        if (i === 0) offscreenMaskCtx.moveTo(px, py);
        else offscreenMaskCtx.lineTo(px, py);
    }
    offscreenMaskCtx.closePath();
    offscreenMaskCtx.fillStyle = '#FFFFFF';
    offscreenMaskCtx.fill();

    const maskData = offscreenMaskCtx.getImageData(0, 0, width, height).data;
    let rSum = 0, gSum = 0, bSum = 0, count = 0;

    for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
            const maskIndex = ((y - minY) * width + (x - minX)) * 4 + 3; 
            
            if (maskData[maskIndex] > 128) {
                const imgIndex = (y * mainCanvas.width + x) * 4;
                rSum += cachedImageData[imgIndex];
                gSum += cachedImageData[imgIndex + 1];
                bSum += cachedImageData[imgIndex + 2];
                count++;
            }
        }
    }

    if (count > 0) updateDisplay(Math.round(rSum/count), Math.round(gSum/count), Math.round(bSum/count));
}

function handleInteractionStart(e) {
    if (!cachedImageData) return;

    if (transitionAnimationId) {
        cancelAnimationFrame(transitionAnimationId);
        transitionAnimationId = null;
    }

    isDragging = true;
    
    if (isLocked) {
        const coords = getClientCoords(e);
        const floatCoords = screenToImageCoordsFloat(coords.x, coords.y);
        const intPixel = { x: Math.floor(floatCoords.x), y: Math.floor(floatCoords.y) };

        if (selectionMode === 1) { 
            marqueeResizeAction = getMarqueeHitAction(floatCoords.x, floatCoords.y);
            if (marqueeResizeAction === 'new') {
                marqueeRect = { x1: intPixel.x, y1: intPixel.y, x2: intPixel.x, y2: intPixel.y };
            }
            interactionStartImgPixel = intPixel;
            if (marqueeRect) {
                const norm = getNormalizedMarquee();
                interactionStartMarquee = { minX: norm.minX, maxX: norm.maxX, minY: norm.minY, maxY: norm.maxY };
            }
        } else if (selectionMode === 2) { 
            if (isPointInLassoPoly(floatCoords)) {
                marqueeResizeAction = 'move';
                startLassoPoints = lassoPoints.map(p => ({...p}));
            } else {
                marqueeResizeAction = 'new';
                lassoPoints = [floatCoords]; 
            }
            interactionStartImgPixel = floatCoords; 
        } else { 
            dragStartTouch.x = coords.x;
            dragStartTouch.y = coords.y;
            
            if (crosshair.style.display === 'none') {
               dragStartCrosshair.x = coords.x;
               dragStartCrosshair.y = coords.y;
               processCoordinates(coords.x, coords.y);
            } else {
               dragStartCrosshair.x = crosshairPos.x;
               dragStartCrosshair.y = crosshairPos.y;
            }
        }
    } else {
        if (e.touches && e.touches.length === 2) {
            lastPinchDist = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY
            );
            lastPinchCenter = {
                x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
                y: (e.touches[0].clientY + e.touches[1].clientY) / 2
            };
        } else {
            const coords = getClientCoords(e);
            lastPanTouch = { x: coords.x, y: coords.y };
        }
    }
}

function handleInteractionMove(e) {
    if (!cachedImageData || !isDragging) return;

    if (isLocked) {
        const coords = getClientCoords(e);
        const floatCoords = screenToImageCoordsFloat(coords.x, coords.y);
        
        if (selectionMode === 1) { 
            const currentPixel = { x: Math.floor(floatCoords.x), y: Math.floor(floatCoords.y) };
            const dx = currentPixel.x - interactionStartImgPixel.x;
            const dy = currentPixel.y - interactionStartImgPixel.y;
            
            const clampX = (val) => Math.max(0, Math.min(mainCanvas.width - 1, val));
            const clampY = (val) => Math.max(0, Math.min(mainCanvas.height - 1, val));
            const startR = interactionStartMarquee;

            if (marqueeResizeAction === 'new') {
                marqueeRect.x2 = clampX(currentPixel.x);
                marqueeRect.y2 = clampY(currentPixel.y);
            } else if (marqueeResizeAction === 'move') {
                const width = startR.maxX - startR.minX;
                const height = startR.maxY - startR.minY;
                
                let newX = clampX(startR.minX + dx);
                if (newX + width >= mainCanvas.width) newX = mainCanvas.width - 1 - width;
                
                let newY = clampY(startR.minY + dy);
                if (newY + height >= mainCanvas.height) newY = mainCanvas.height - 1 - height;
                
                marqueeRect = { x1: newX, y1: newY, x2: newX + width, y2: newY + height };
            } else {
                marqueeRect = { x1: startR.minX, y1: startR.minY, x2: startR.maxX, y2: startR.maxY }; 
                if (marqueeResizeAction.includes('n')) marqueeRect.y1 = clampY(startR.minY + dy);
                if (marqueeResizeAction.includes('s')) marqueeRect.y2 = clampY(startR.maxY + dy);
                if (marqueeResizeAction.includes('w')) marqueeRect.x1 = clampX(startR.minX + dx);
                if (marqueeResizeAction.includes('e')) marqueeRect.x2 = clampX(startR.maxX + dx);
            }

            triggerAverageCalculation(); 

        } else if (selectionMode === 2) { 
            if (marqueeResizeAction === 'new') {
                const lastPoint = lassoPoints[lassoPoints.length - 1];
                if (Math.hypot(floatCoords.x - lastPoint.x, floatCoords.y - lastPoint.y) > 2) {
                    lassoPoints.push(floatCoords);
                }
            } else if (marqueeResizeAction === 'move') {
                const dx = floatCoords.x - interactionStartImgPixel.x;
                const dy = floatCoords.y - interactionStartImgPixel.y;
                
                let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
                for (let p of startLassoPoints) {
                    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
                    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
                }
                
                const clampDx = Math.max(-minX, Math.min(mainCanvas.width - 1 - maxX, dx));
                const clampDy = Math.max(-minY, Math.min(mainCanvas.height - 1 - maxY, dy));

                lassoPoints = startLassoPoints.map(p => ({
                    x: p.x + clampDx,
                    y: p.y + clampDy
                }));
            }

            triggerAverageCalculation(); 

        } else { 
            const deltaX = coords.x - dragStartTouch.x;
            const deltaY = coords.y - dragStartTouch.y;

            const targetX = dragStartCrosshair.x + deltaX;
            const targetY = dragStartCrosshair.y + deltaY;

            if (!animationFrameId) {
                animationFrameId = requestAnimationFrame(() => {
                    processCoordinates(targetX, targetY);
                    animationFrameId = null;
                });
            }
        }
    } else {
        if (e.touches && e.touches.length === 2) {
            const dist = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY
            );
            const currentPinchCenter = {
                x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
                y: (e.touches[0].clientY + e.touches[1].clientY) / 2
            };

            if (lastPinchDist && lastPinchCenter) {
                const scaleFactor = dist / lastPinchDist;
                const newScale = Math.max(1, Math.min(currentScale * scaleFactor, 40));
                const actualScaleFactor = newScale / currentScale;

                const rect = canvasContainer.getBoundingClientRect();
                const pointerX = lastPinchCenter.x - (rect.left + rect.width / 2);
                const pointerY = lastPinchCenter.y - (rect.top + rect.height / 2);

                currentPanX -= (pointerX - currentPanX) * (actualScaleFactor - 1);
                currentPanY -= (pointerY - currentPanY) * (actualScaleFactor - 1);

                currentPanX += (currentPinchCenter.x - lastPinchCenter.x);
                currentPanY += (currentPinchCenter.y - lastPinchCenter.y);

                currentScale = newScale;
            }
            lastPinchDist = dist;
            lastPinchCenter = currentPinchCenter;
        } else if (lastPanTouch) {
            const coords = getClientCoords(e);
            currentPanX += (coords.x - lastPanTouch.x);
            currentPanY += (coords.y - lastPanTouch.y);
            lastPanTouch = { x: coords.x, y: coords.y };
        }
        
        clampPan();
        applyTransform();
    }
}

function handleInteractionEnd() {
    isDragging = false;
    
    if (selectionMode === 1 && marqueeRect) {
        const norm = getNormalizedMarquee();
        marqueeRect = { x1: norm.minX, y1: norm.minY, x2: norm.maxX, y2: norm.maxY };
        calculateAverageRectCore();
    }
    if (selectionMode === 2 && lassoPoints.length > 2) {
        calculateAverageLassoCore();
    }
    
    lastPinchDist = null;
    lastPinchCenter = null;
    lastPanTouch = null;
}

canvasContainer.addEventListener('wheel', (e) => {
    if (isLocked || !cachedImageData) return;
    e.preventDefault();

    const rect = canvasContainer.getBoundingClientRect();
    const pointerX = e.clientX - (rect.left + rect.width / 2);
    const pointerY = e.clientY - (rect.top + rect.height / 2);

    const zoomSensitivity = 0.005;
    const delta = -e.deltaY * zoomSensitivity;
    const scaleFactor = Math.exp(delta); 

    const newScale = Math.max(1, Math.min(currentScale * scaleFactor, 40));
    const actualScaleFactor = newScale / currentScale;

    currentPanX -= (pointerX - currentPanX) * (actualScaleFactor - 1);
    currentPanY -= (pointerY - currentPanY) * (actualScaleFactor - 1);

    currentScale = newScale;

    clampPan();
    applyTransform();
}, { passive: false });

function processCoordinates(targetX, targetY) {
    const rect = mainCanvas.getBoundingClientRect();
    const scaleX = mainCanvas.width / rect.width;
    const scaleY = mainCanvas.height / rect.height;

    const clampedX = Math.max(rect.left, Math.min(targetX, rect.right - 1));
    const clampedY = Math.max(rect.top, Math.min(targetY, rect.bottom - 1));

    crosshairPos.x = clampedX;
    crosshairPos.y = clampedY;

    const x = Math.floor((clampedX - rect.left) * scaleX);
    const y = Math.floor((clampedY - rect.top) * scaleY);

    if (x < 0 || y < 0 || x >= mainCanvas.width || y >= mainCanvas.height) return;

    if (selectionMode === 0) {
        crosshair.style.display = 'block';
        crosshair.style.transform = `translate3d(${clampedX - 23}px, ${clampedY - 23}px, 0)`;
    }

    const index = (y * mainCanvas.width + x) * 4;
    const r = cachedImageData[index];
    const g = cachedImageData[index + 1];
    const b = cachedImageData[index + 2];
    
    updateDisplay(r, g, b);
}

function updateDisplay(r, g, b) {
    if (r === lastR && g === lastG && b === lastB) return;
    lastR = r; lastG = g; lastB = b;

    currentHex = "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase();
    
    hexDisplay.textContent = currentHex;
    rgbDisplay.textContent = `${r}, ${g}, ${b}`;
    swatch.style.backgroundColor = `rgb(${r}, ${g}, ${b})`;
    
    nativeColorInput.value = currentHex;

    const luminance = (0.2126 * r) + (0.7152 * g) + (0.0722 * b);
    
    if (luminance >= 128) {
        crosshair.classList.add('invert-dark');
    } else {
        crosshair.classList.remove('invert-dark');
    }
    
    resultCard.classList.add('active');
}

function copyToClipboard() {
    if (!currentHex) return;
    
    navigator.clipboard.writeText(currentHex)
        .then(() => {
            hexDisplay.textContent = "COPIED!";
            setTimeout(() => { hexDisplay.textContent = currentHex; }, 800);
        })
        .catch(err => {
            console.error('Data pipeline exception:', err);
            hexDisplay.textContent = "ERROR";
            setTimeout(() => { hexDisplay.textContent = currentHex; }, 800);
        });
}

canvasContainer.addEventListener('touchstart', (e) => { 
    if (cachedImageData) e.preventDefault(); 
    handleInteractionStart(e); 
}, { passive: false });

canvasContainer.addEventListener('touchmove', (e) => { 
    if (cachedImageData) e.preventDefault(); 
    handleInteractionMove(e); 
}, { passive: false });

canvasContainer.addEventListener('touchend', handleInteractionEnd); 

canvasContainer.addEventListener('mousedown', handleInteractionStart);
canvasContainer.addEventListener('mousemove', handleInteractionMove);
canvasContainer.addEventListener('mouseup', handleInteractionEnd);
canvasContainer.addEventListener('mouseleave', handleInteractionEnd);
