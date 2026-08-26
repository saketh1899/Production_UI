(function () {
    'use strict';

    const configuredPollMs = parseInt($('.dashboard-container').data('poll-interval-ms'), 10);
    const POLL_INTERVAL_MS = Number.isFinite(configuredPollMs) && configuredPollMs >= 500
        ? configuredPollMs
        : 2000;
    let pollTimer = null;
    let currentServerIps = [];
    let isPolling = false;
    let consecutiveFailures = 0;
    const passWaitState = new Map();
    let passWaitTimerInterval = null;
    const lastStationStatus = new Map();
    const WAIT_TRACKED_STATUSES = ['status-passed', 'status-aborted', 'status-failed'];
    const STATUS_CLASSES = ['status-passed', 'status-running', 'status-waiting', 'status-failed', 'status-aborted', 'status-unknown'];
    const configuredFlagDelayMin = parseInt($('.dashboard-container').data('flag-pending-minutes'), 10);
    const FLAG_PENDING_DELAY_MS = (Number.isFinite(configuredFlagDelayMin) && configuredFlagDelayMin >= 0
        ? configuredFlagDelayMin
        : 5) * 60 * 1000;

    function isWaitTrackedStatus(statusClass) {
        return WAIT_TRACKED_STATUSES.indexOf(statusClass) >= 0;
    }

    function getWaitElapsedMs(state) {
        return Date.now() - state.startedAt;
    }

    function ensureFlagRaised(state) {
        if (isFlagRaised(state) && !state.flagRaised) {
            state.flagRaised = true;
            state.flagRaisedAt = Date.now();
        }
    }

    function getPendingElapsedMs(state) {
        if (!state.flagRaisedAt) {
            return 0;
        }
        return Date.now() - state.flagRaisedAt;
    }

    function isFlagRaised(state) {
        return getWaitElapsedMs(state) >= FLAG_PENDING_DELAY_MS;
    }

    function shouldShowPassWaitPanel(station, state) {
        return isWaitTrackedStatus(station.statusCssClass) && state && isFlagRaised(state);
    }

    function getPassWaitPanelVariant(statusClass) {
        if (statusClass === 'status-failed') {
            return 'pass-wait-panel--failed';
        }
        if (statusClass === 'status-aborted') {
            return 'pass-wait-panel--aborted';
        }
        return 'pass-wait-panel--passed';
    }

    function formatElapsedDuration(elapsedMs) {
        const totalSeconds = Math.floor(elapsedMs / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;

        if (hours > 0) {
            return hours + ':' + String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
        }
        return String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
    }

    function startPassWaitClock() {
        if (passWaitTimerInterval) {
            return;
        }
        passWaitTimerInterval = setInterval(updatePassWaitDisplays, 1000);
    }

    function stopPassWaitClock() {
        if (passWaitTimerInterval) {
            clearInterval(passWaitTimerInterval);
            passWaitTimerInterval = null;
        }
    }

    function updatePassWaitDisplays() {
        passWaitState.forEach(function (state, key) {
            const $card = findStationCard(key);
            if (!$card.length) {
                return;
            }

            const statusClass = STATUS_CLASSES.find(function (cls) { return $card.hasClass(cls); }) || 'status-unknown';
            const station = { statusCssClass: statusClass };

            ensureFlagRaised(state);

            syncPassWaitPanel($card, key, station);

            if (shouldShowPassWaitPanel(station, state)) {
                $card.find('.pass-wait-timer').text(formatElapsedDuration(getPendingElapsedMs(state)));
            }
        });
    }

    function clearPassWaitState() {
        passWaitState.clear();
        lastStationStatus.clear();
        stopPassWaitClock();
    }

    function processPassWaitTracker(key, rawStation, previousStatusClass) {
        const station = normalizeStation(rawStation);
        const status = station.statusCssClass;

        if (isWaitTrackedStatus(status)) {
            const state = passWaitState.get(key);
            const passCount = station.passedProcessCount;
            const isNewWait = !state
                || previousStatusClass !== status
                || (status === 'status-passed' && passCount > 0 && state.passFlag !== passCount);

            if (isNewWait) {
                passWaitState.set(key, {
                    startedAt: Date.now(),
                    flagRaised: false,
                    flagRaisedAt: null,
                    passFlag: status === 'status-passed'
                        ? (passCount > 0 ? passCount : (state ? state.passFlag + 1 : 1))
                        : 0,
                    lastSerial: station.serialNumber,
                    statusClass: status
                });
            }

            startPassWaitClock();
            lastStationStatus.set(key, status);
            return;
        }

        if (status === 'status-running' || status === 'status-waiting') {
            passWaitState.delete(key);
        } else if (!isWaitTrackedStatus(status)) {
            passWaitState.delete(key);
        }

        if (passWaitState.size === 0) {
            stopPassWaitClock();
        }

        lastStationStatus.set(key, status);
    }

    function buildPassWaitPanelHtml(state, statusClass) {
        ensureFlagRaised(state);
        const elapsed = formatElapsedDuration(getPendingElapsedMs(state));
        const panelVariant = getPassWaitPanelVariant(statusClass);
        const delayMinutes = Math.round(FLAG_PENDING_DELAY_MS / 60000);
        return `
            <div class="pass-wait-panel ${panelVariant} pass-wait-panel--raised" title="Pending for next test — flag raised after ${delayMinutes} minute wait">
                <div class="pass-flag" aria-hidden="true">
                    <span class="pass-flag-pole"></span>
                    <span class="pass-flag-banner"></span>
                </div>
                <div class="pass-wait-timer">${elapsed}</div>
                <div class="pass-wait-label">Pending</div>
            </div>`;
    }

    function syncPassWaitPanel($card, key, station) {
        const state = passWaitState.get(key);
        const $panel = $card.find('.pass-wait-panel');
        const shouldShow = shouldShowPassWaitPanel(station, state);
        const panelVariant = getPassWaitPanelVariant(station.statusCssClass);

        if (!shouldShow) {
            $card.removeClass('has-pass-wait');
            $panel.remove();
            return;
        }

        ensureFlagRaised(state);
        $card.addClass('has-pass-wait');
        if ($panel.length === 0) {
            $card.find('.station-body').append(buildPassWaitPanelHtml(state, station.statusCssClass));
        } else {
            $panel
                .removeClass('pass-wait-panel--passed pass-wait-panel--failed pass-wait-panel--aborted')
                .addClass(panelVariant);
            $panel.find('.pass-wait-timer').text(formatElapsedDuration(getPendingElapsedMs(state)));
        }
    }

    const $serverIpInput = $('#serverIpInput');
    const $connectBtn = $('#connectBtn');
    const $disconnectBtn = $('#disconnectBtn');
    const $connectionStatus = $('#connectionStatus');
    const $stationGrid = $('#stationGrid');
    const $dashboardFilters = $('#dashboardFilters');
    const $machineTypeSelect = $('#machineTypeSelect');
    const $fixturesPerRackSelect = $('#fixturesPerRackSelect');
    const $fixturesPerRackLabel = $('#fixturesPerRackLabel');

    let lastFetchedStations = [];
    let lastServerIps = [];
    let activeRackCount = 0;

    const layoutFilters = {
        machineType: null,
        fixturesPerRack: null
    };

    function loadSavedFilters() {
        try {
            const saved = JSON.parse(sessionStorage.getItem('pw-layout-filters') || 'null');
            if (saved && typeof saved === 'object') {
                layoutFilters.machineType = saved.machineType || null;
                layoutFilters.fixturesPerRack = saved.fixturesPerRack || saved.layer || null;
                if (layoutFilters.fixturesPerRack === 1) {
                    layoutFilters.fixturesPerRack = null;
                }
            }
        } catch (e) {
            /* ignore */
        }
    }

    function saveFilters() {
        sessionStorage.setItem('pw-layout-filters', JSON.stringify(layoutFilters));
    }

    function getFixturesPerRack() {
        return layoutFilters.fixturesPerRack === 2 || layoutFilters.fixturesPerRack === 3
            ? layoutFilters.fixturesPerRack
            : null;
    }

    function autoDetectLayoutFilters(stations) {
        if (!layoutFilters.machineType) {
            const minNum = getMinStationNumber(stations);
            layoutFilters.machineType = minNum !== null ? 'rack' : 'single';
        }
        saveFilters();
    }

    function updateFilterBar(stations) {
        if (!stations || stations.length === 0) {
            $dashboardFilters.attr('hidden', true);
            return;
        }

        $dashboardFilters.removeAttr('hidden');
        $machineTypeSelect.val(layoutFilters.machineType || '');

        const isRack = layoutFilters.machineType === 'rack';
        if (isRack) {
            $fixturesPerRackLabel.removeAttr('hidden');
            $fixturesPerRackSelect.removeAttr('hidden').prop('disabled', false);
            $fixturesPerRackSelect.val(String(layoutFilters.fixturesPerRack || ''));
        } else {
            $fixturesPerRackLabel.attr('hidden', true);
            $fixturesPerRackSelect.attr('hidden', true).prop('disabled', true).val('');
        }
    }

    function applyFiltersAndRender() {
        if (lastFetchedStations.length === 0) {
            return;
        }
        saveFilters();
        updateFilterBar(lastFetchedStations);
        renderStationsFull(lastFetchedStations, lastServerIps);
        $stationGrid.attr('data-signature', buildStructureSignature(lastFetchedStations, lastServerIps));
    }

    function bindFilterEvents() {
        $machineTypeSelect.on('change', function () {
            layoutFilters.machineType = $(this).val() || null;
            if (layoutFilters.machineType !== 'rack') {
                layoutFilters.fixturesPerRack = null;
            }
            applyFiltersAndRender();
        });

        $fixturesPerRackSelect.on('change', function () {
            const value = parseInt($(this).val(), 10);
            layoutFilters.fixturesPerRack = value === 2 || value === 3 ? value : null;
            applyFiltersAndRender();
        });
    }

    loadSavedFilters();
    bindFilterEvents();

    function getMinStationNumber(stations) {
        const numbers = stations
            .map(extractStationNumber)
            .filter(function (num) { return num !== null; });
        if (numbers.length === 0) {
            return null;
        }
        return Math.min.apply(null, numbers);
    }

    function getApiField(station, snakeCase, camelCase, fallback) {
        if (station[snakeCase] !== undefined && station[snakeCase] !== null && station[snakeCase] !== '') {
            return station[snakeCase];
        }
        if (station[camelCase] !== undefined && station[camelCase] !== null && station[camelCase] !== '') {
            return station[camelCase];
        }
        return fallback;
    }

    function parseServerIps(value) {
        return value
            .split(/[,;\n\r]+/)
            .map(function (ip) { return ip.trim(); })
            .filter(function (ip) { return ip.length > 0; });
    }

    function normalizeStation(station) {
        const serialNumber = getApiField(station, 'current_serial_number', 'currentSerialNumber', '');
        return {
            stationId: getApiField(station, 'station_id', 'stationId', 0),
            stationName: getApiField(station, 'station_name', 'stationName', 'Unknown Station'),
            serverIp: getApiField(station, 'server_ip', 'serverIp', ''),
            statusLabel: getApiField(station, 'status_label', 'statusLabel', 'Unknown'),
            statusCssClass: getApiField(station, 'status_css_class', 'statusCssClass', 'status-unknown'),
            serialNumber: serialNumber,
            passedProcessCount: parseInt(getApiField(station, 'passed_process_count', 'passedProcessCount', 0), 10) || 0
        };
    }

    function deriveProductName(stations) {
        const productCounts = {};
        stations.forEach(function (rawStation) {
            const product = getApiField(rawStation, 'product_name', 'productName', '');
            if (product) {
                productCounts[product] = (productCounts[product] || 0) + 1;
            }
        });

        const productNames = Object.keys(productCounts);
        if (productNames.length > 0) {
            productNames.sort(function (a, b) { return productCounts[b] - productCounts[a]; });
            return productNames[0];
        }

        const planCounts = {};
        stations.forEach(function (rawStation) {
            const plan = getApiField(rawStation, 'current_process_plan', 'currentProcessPlan', '');
            if (plan) {
                planCounts[plan] = (planCounts[plan] || 0) + 1;
            }
        });
        const planNames = Object.keys(planCounts);
        if (planNames.length > 0) {
            planNames.sort(function (a, b) { return planCounts[b] - planCounts[a]; });
            return planNames[0];
        }

        return 'Unknown Product';
    }

    function escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function resolveServerLabel(stations, serverLabel) {
        if (serverLabel) {
            return serverLabel;
        }
        if (stations.length > 0) {
            return normalizeStation(stations[0]).serverIp || 'Unknown Server';
        }
        return 'Unknown Server';
    }

    function buildProductBannerHtml(stations, serverLabel) {
        const productName = deriveProductName(stations);
        const label = resolveServerLabel(stations, serverLabel);
        return `
            <div class="rack-product-banner">
                <span class="rack-product-name">${escapeHtml(productName)}</span>
                <span class="rack-product-separator" aria-hidden="true">—</span>
                <span class="rack-product-server">${escapeHtml(label)}</span>
            </div>`;
    }

    function setConnectionStatus(message, type, errors) {
        $connectionStatus
            .removeClass('connected error polling')
            .addClass(type || '');

        let html = escapeHtml(message || '');
        if (errors && errors.length > 0) {
            html += errors.map(function (err) {
                const serverIp = escapeHtml(err.server_ip || err.serverIp || 'Unknown server');
                const errorText = escapeHtml(err.error || 'Connection failed');
                return '<span class="server-error">' + serverIp + ': ' + errorText + '</span>';
            }).join('');
        }

        $connectionStatus.html(html);
    }

    function buildStationCard(rawStation) {
        const station = normalizeStation(rawStation);
        const cardKey = station.serverIp + '-' + station.stationId;
        const state = passWaitState.get(cardKey);
        const passWaitHtml = shouldShowPassWaitPanel(station, state)
            ? buildPassWaitPanelHtml(state, station.statusCssClass)
            : '';
        const hasPassWait = passWaitHtml ? ' has-pass-wait' : '';

        return `
            <div class="station-card ${station.statusCssClass}${hasPassWait}" data-station-key="${escapeHtml(cardKey)}" title="${escapeHtml(station.stationName)}">
                <div class="station-body">
                    <div class="station-main">
                        <div class="station-name">${escapeHtml(station.stationName)}</div>
                        <div class="station-meta">
                            <span class="status-badge">${escapeHtml(station.statusLabel)}</span>
                            ${station.serialNumber ? `<span class="station-serial">${escapeHtml(station.serialNumber)}</span>` : ''}
                        </div>
                    </div>
                    ${passWaitHtml}
                </div>
            </div>`;
    }

    const $container = $('.dashboard-container');
    const RACK_COUNT = parseInt($container.data('rack-count'), 10) || 6;
    const SLOTS_PER_RACK = parseInt($container.data('slots-per-rack'), 10) || 3;

    function extractStationNumber(rawStation) {
        const normalized = normalizeStation(rawStation);
        const nameMatch = normalized.stationName.match(/(\d+)\s*$/);
        if (nameMatch) {
            return parseInt(nameMatch[1], 10);
        }
        if (normalized.stationId) {
            return normalized.stationId;
        }
        return null;
    }

    function buildRackLayout(stations, fixturesPerRack) {
        const slotsPerRack = fixturesPerRack === 2 || fixturesPerRack === 3 ? fixturesPerRack : 3;
        const overflow = [];
        const numbered = stations.map(function (station) {
            return { station: station, num: extractStationNumber(station) };
        });
        const validNumbers = numbered
            .filter(function (item) { return item.num !== null; })
            .map(function (item) { return item.num; });

        if (validNumbers.length === 0) {
            return { racks: [], overflow: stations, useRackLayout: false, rackCount: 0, slotsPerRack: slotsPerRack };
        }

        const minNum = Math.min.apply(null, validNumbers);
        const maxNum = Math.max.apply(null, validNumbers);
        const maxOffset = maxNum - minNum;
        const rackCount = Math.max(Math.floor(maxOffset / slotsPerRack) + 1, 1);

        const racks = Array.from({ length: rackCount }, function () {
            return Array(slotsPerRack).fill(null);
        });

        numbered.forEach(function (item) {
            if (item.num === null) {
                overflow.push(item.station);
                return;
            }

            const offset = item.num - minNum;
            const rackIndex = Math.floor(offset / slotsPerRack);
            const slotIndex = offset % slotsPerRack;

            if (rackIndex >= 0 && rackIndex < rackCount) {
                if (racks[rackIndex][slotIndex]) {
                    overflow.push(item.station);
                } else {
                    racks[rackIndex][slotIndex] = item.station;
                }
            } else {
                overflow.push(item.station);
            }
        });

        return {
            racks: racks,
            overflow: overflow,
            useRackLayout: true,
            rackCount: rackCount,
            slotsPerRack: slotsPerRack,
            minNum: minNum
        };
    }

    function buildRackSlotHtml(station) {
        if (!station) {
            return '<div class="rack-slot rack-slot-empty" aria-hidden="true"></div>';
        }
        return '<div class="rack-slot">' + buildStationCard(station) + '</div>';
    }

    function buildSingleLayoutHtml(stations, serverLabel) {
        return `
            <div class="rack-board single-board">
                ${buildProductBannerHtml(stations, serverLabel)}
                <div class="station-grid single-grid">${stations.map(buildStationCard).join('')}</div>
            </div>`;
    }

    function buildRackLayoutHtml(stations, serverLabel) {
        if (layoutFilters.machineType === 'single') {
            return buildSingleLayoutHtml(stations, serverLabel);
        }

        const fixturesPerRack = getFixturesPerRack();
        if (!fixturesPerRack) {
            return `
                <div class="rack-board">
                    ${buildProductBannerHtml(stations, serverLabel)}
                    <div class="empty-state">
                        <p>Select <strong>2 per rack</strong> or <strong>3 per rack</strong> from the Fixtures dropdown to arrange stations.</p>
                    </div>
                </div>`;
        }

        const layout = buildRackLayout(stations, fixturesPerRack);
        activeRackCount = layout.rackCount || 0;

        if (!layout.useRackLayout) {
            return buildSingleLayoutHtml(stations, serverLabel);
        }

        let html = `
            <div class="rack-board view-rack-mode">
                ${buildProductBannerHtml(stations, serverLabel)}
                <div class="rack-layout" style="grid-template-columns: repeat(${layout.rackCount}, minmax(148px, 1fr));">`;

        layout.racks.forEach(function (slots, rackIndex) {
            html += `
                    <div class="rack-column">
                        <div class="rack-header" data-fixtures="${fixturesPerRack}">Rack ${rackIndex + 1}</div>
                        <div class="rack-slots">
                            ${slots.map(buildRackSlotHtml).join('')}
                        </div>
                    </div>`;
        });
        html += '</div>';

        if (layout.overflow.length > 0) {
            html += `
                <div class="rack-overflow">
                    <div class="rack-overflow-title">Unassigned fixtures</div>
                    <div class="station-grid">${layout.overflow.map(buildStationCard).join('')}</div>
                </div>`;
        }

        html += '</div>';
        return html;
    }

    function buildServerSectionHtml(serverLabel, serverStations) {
        return `
            <div class="server-section">
                ${buildRackLayoutHtml(serverStations, serverLabel)}
            </div>`;
    }

    function getDensityTier(stationCount) {
        if (stationCount <= 18) return 'lg';
        if (stationCount <= 35) return 'md';
        if (stationCount <= 55) return 'sm';
        return 'xs';
    }

    function getDensityConfig(tier) {
        const configs = {
            lg: { minCard: 155, gap: 10, maxCols: 6, targetRows: 3, nameSize: '0.92rem', badgeSize: '0.78rem', serialSize: '0.6rem', minHeight: 78 },
            md: { minCard: 145, gap: 9,  maxCols: 6, targetRows: 3, nameSize: '0.85rem', badgeSize: '0.74rem', serialSize: '0.58rem', minHeight: 74 },
            sm: { minCard: 135, gap: 8,  maxCols: 6, targetRows: 3, nameSize: '0.8rem',  badgeSize: '0.7rem',  serialSize: '0.55rem', minHeight: 70 },
            xs: { minCard: 125, gap: 8,  maxCols: 6, targetRows: 3, nameSize: '0.76rem', badgeSize: '0.66rem', serialSize: '0.52rem', minHeight: 66 }
        };
        return configs[tier] || configs.lg;
    }

    function applyAdaptiveLayout(stationCount, stationsPerSection) {
        const container = document.querySelector('.dashboard-container');
        if (!container) {
            return;
        }

        const sectionCount = stationsPerSection || stationCount;
        const tier = getDensityTier(sectionCount);
        const config = getDensityConfig(tier);

        container.dataset.layout = layoutFilters.machineType === 'single' ? 'single' : 'rack';
        container.dataset.viewMode = layoutFilters.machineType || 'rack';
        container.dataset.density = tier;
        container.dataset.stationCount = String(stationCount);
        container.dataset.sectionCount = String(sectionCount);

        const visibleRackCount = layoutFilters.machineType === 'rack' ? activeRackCount : 0;
        if (visibleRackCount > 0) {
            container.style.setProperty('--rack-count', String(visibleRackCount));
        }
        container.style.setProperty('--grid-gap', config.gap + 'px');
        if (layoutFilters.machineType === 'single') {
            container.style.setProperty('--grid-columns', '4');
        } else {
            container.style.setProperty('--grid-columns', String(config.maxCols));
        }
        container.style.setProperty('--card-name-size', config.nameSize);
        container.style.setProperty('--card-badge-size', config.badgeSize);
        container.style.setProperty('--card-serial-size', config.serialSize);
        container.style.setProperty('--card-min-height', config.minHeight + 'px');
    }

    let resizeTimer = null;
    function scheduleLayoutRefresh() {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function () {
            const count = parseInt($('.dashboard-container').attr('data-station-count'), 10);
            const sectionCount = parseInt($('.dashboard-container').attr('data-section-count'), 10);
            if (count > 0) {
                applyAdaptiveLayout(count, sectionCount || count);
            }
        }, 150);
    }

    function groupStationsByServer(stations) {
        const groups = new Map();
        stations.forEach(function (station) {
            const normalized = normalizeStation(station);
            const serverIp = normalized.serverIp || 'Unknown Server';
            if (!groups.has(serverIp)) {
                groups.set(serverIp, []);
            }
            groups.get(serverIp).push(station);
        });
        return groups;
    }

    function stationCardKey(rawStation) {
        const station = normalizeStation(rawStation);
        return station.serverIp + '-' + station.stationId;
    }

    function buildStructureSignature(stations, serverIps) {
        const groups = groupStationsByServer(stations);
        const sectionKeys = Array.from(groups.keys()).sort();
        const stationKeys = stations.map(stationCardKey).sort();
        return serverIps.join(',') + '||' + sectionKeys.join(',') + '||' + stationKeys.join(',');
    }

    function findStationCard(key) {
        return $stationGrid.find('.station-card').filter(function () {
            return this.getAttribute('data-station-key') === key;
        });
    }

    function patchStationCard($card, rawStation) {
        const station = normalizeStation(rawStation);
        const key = station.serverIp + '-' + station.stationId;
        const currentStatus = STATUS_CLASSES.find(function (cls) { return $card.hasClass(cls); });

        processPassWaitTracker(key, rawStation, currentStatus);

        if (currentStatus !== station.statusCssClass) {
            STATUS_CLASSES.forEach(function (cls) { $card.removeClass(cls); });
            $card.addClass(station.statusCssClass);
        }

        if ($card.attr('title') !== station.stationName) {
            $card.attr('title', station.stationName);
        }

        const $name = $card.find('.station-name');
        if ($name.text() !== station.stationName) {
            $name.text(station.stationName);
        }

        const $badge = $card.find('.status-badge');
        if ($badge.text() !== station.statusLabel) {
            $badge.text(station.statusLabel);
        }

        const $meta = $card.find('.station-meta');
        let $serial = $meta.find('.station-serial');
        if (station.serialNumber) {
            if ($serial.length === 0) {
                $serial = $('<span class="station-serial"></span>').appendTo($meta);
            }
            if ($serial.text() !== station.serialNumber) {
                $serial.text(station.serialNumber);
            }
        } else if ($serial.length) {
            $serial.remove();
        }

        syncPassWaitPanel($card, key, station);
    }

    function applyPassWaitToStations(stations) {
        stations.forEach(function (rawStation) {
            const key = stationCardKey(rawStation);
            const previousStatus = lastStationStatus.get(key) || null;
            processPassWaitTracker(key, rawStation, previousStatus);

            const $card = findStationCard(key);
            if ($card.length) {
                syncPassWaitPanel($card, key, normalizeStation(rawStation));
            }
        });
    }

    function renderStationsFull(stations, serverIps) {
        if (!stations || stations.length === 0) {
            $('.dashboard-container').removeAttr('data-density data-station-count data-section-count data-view-mode');
            $dashboardFilters.attr('hidden', true);
            $stationGrid.html(`
                <div class="empty-state">
                    <p>No stations found on the connected server(s).</p>
                </div>`);
            return;
        }

        autoDetectLayoutFilters(stations);
        updateFilterBar(stations);

        const groups = groupStationsByServer(stations);
        const showServerSections = serverIps.length > 1 || groups.size > 1;
        const serversToRender = groups.size > 0
            ? Array.from(groups.keys())
            : serverIps;
        let html = '';

        if (showServerSections) {
            serversToRender.forEach(function (serverIp) {
                const serverStations = groups.get(serverIp) || [];
                if (serverStations.length === 0) {
                    return;
                }

                html += buildServerSectionHtml(serverIp, serverStations);
            });
        } else {
            const serverLabel = stations.length > 0
                ? normalizeStation(stations[0]).serverIp
                : (serverIps[0] || '');
            html = buildRackLayoutHtml(stations, serverLabel);
        }

        $stationGrid.html(html);

        let maxSectionSize = stations.length;
        if (layoutFilters.machineType === 'single') {
            maxSectionSize = stations.length;
        } else if (getFixturesPerRack()) {
            maxSectionSize = stations.length;
        }
        if (showServerSections) {
            maxSectionSize = Math.max.apply(null, Array.from(groups.values()).map(function (groupStations) {
                return groupStations.length;
            }));
        }
        applyAdaptiveLayout(stations.length, maxSectionSize);
        applyPassWaitToStations(stations);
        updatePassWaitDisplays();
    }

    function updateStations(stations, serverIps) {
        lastFetchedStations = Array.isArray(stations) ? stations : [];
        lastServerIps = serverIps || [];

        if (!stations || stations.length === 0) {
            $stationGrid.removeAttr('data-signature');
            $('.dashboard-container').removeAttr('data-density data-station-count data-section-count data-view-mode');
            $dashboardFilters.attr('hidden', true);
            $stationGrid.html(`
                <div class="empty-state">
                    <p>No stations found on the connected server(s).</p>
                </div>`);
            return;
        }

        const signature = buildStructureSignature(stations, serverIps);
        if ($stationGrid.attr('data-signature') !== signature) {
            renderStationsFull(stations, serverIps);
            $stationGrid.attr('data-signature', signature);
            return;
        }

        stations.forEach(function (rawStation) {
            const key = stationCardKey(rawStation);
            const $card = findStationCard(key);
            if ($card.length) {
                patchStationCard($card, rawStation);
            }
        });
        updateFilterBar(stations);
        updatePassWaitDisplays();
    }

    function fetchStations() {
        if (currentServerIps.length === 0) {
            return;
        }

        $.ajax({
            url: '/Dashboard/Stations',
            method: 'GET',
            data: { serverIp: currentServerIps.join(',') },
            dataType: 'json',
            timeout: 15000
        })
            .done(function (response) {
                consecutiveFailures = 0;
                const stations = response.stations || response.Stations || response;
                const errors = response.errors || response.Errors || [];
                updateStations(stations, currentServerIps);

                const serverCount = currentServerIps.length;
                const stationCount = Array.isArray(stations) ? stations.length : 0;
                let statusMessage = serverCount + ' server(s), ' + stationCount + ' station(s)';

                if (errors.length > 0 && stationCount > 0) {
                    setConnectionStatus(statusMessage, 'connected', errors);
                } else if (errors.length > 0) {
                    setConnectionStatus('Failed to connect to all servers.', 'error', errors);
                } else {
                    setConnectionStatus(statusMessage, 'connected');
                }
            })
            .fail(function (xhr) {
                consecutiveFailures++;
                let message = 'Failed to fetch station data.';
                let errors = [];

                if (xhr.status === 0) {
                    message = 'Dashboard server not reachable. Is the app still running?';
                } else if (xhr.responseJSON) {
                    if (xhr.responseJSON.error) {
                        message = xhr.responseJSON.error;
                    }
                    errors = xhr.responseJSON.errors || xhr.responseJSON.Errors || [];
                } else if (xhr.statusText === 'timeout') {
                    message = 'Connection timed out.';
                }

                setConnectionStatus(message, 'error', errors);

                if (xhr.status === 0 || consecutiveFailures >= 3) {
                    stopPolling();
                    $connectBtn.prop('disabled', false);
                    $disconnectBtn.prop('disabled', true);
                    $serverIpInput.prop('disabled', false);
                    isPolling = false;
                }
            });
    }

    function startPolling() {
        stopPolling();
        fetchStations();
        pollTimer = setInterval(fetchStations, POLL_INTERVAL_MS);
        isPolling = true;
    }

    function stopPolling() {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
        isPolling = false;
    }

    function connect() {
        const serverIps = parseServerIps($serverIpInput.val());
        if (serverIps.length === 0) {
            setConnectionStatus('Please enter at least one server IP address.', 'error');
            $serverIpInput.focus();
            return;
        }

        currentServerIps = serverIps;
        consecutiveFailures = 0;
        $connectBtn.prop('disabled', true);
        $disconnectBtn.prop('disabled', false);
        $serverIpInput.prop('disabled', true);
        setConnectionStatus('Connecting to ' + serverIps.length + ' server(s)...', 'polling');

        startPolling();
    }

    function disconnect() {
        stopPolling();
        clearPassWaitState();
        currentServerIps = [];
        lastFetchedStations = [];
        lastServerIps = [];
        $connectBtn.prop('disabled', false);
        $disconnectBtn.prop('disabled', true);
        $serverIpInput.prop('disabled', false);
        setConnectionStatus('', '');
        $dashboardFilters.attr('hidden', true);
        $machineTypeSelect.val('');
        $fixturesPerRackSelect.val('').attr('hidden', true).prop('disabled', true);
        $fixturesPerRackLabel.attr('hidden', true);
        $stationGrid.removeAttr('data-signature');
        $('.dashboard-container').removeAttr('data-density data-station-count data-section-count data-view-mode');
        $stationGrid.html(`
            <div class="empty-state">
                <p>Enter one server address per comma-separated entry, then click <strong>Connect</strong>.</p>
            </div>`);
    }

    $connectBtn.on('click', connect);
    $disconnectBtn.on('click', disconnect);

    $serverIpInput.on('keydown', function (e) {
        if (e.key === 'Enter' && !isPolling) {
            e.preventDefault();
            connect();
        }
    });

    $(window).on('resize', scheduleLayoutRefresh);
    $(window).on('beforeunload', function () {
        stopPolling();
        stopPassWaitClock();
    });
})();
