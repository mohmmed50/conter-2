// Global dashboard state
let rawData = [];
let currentSortColumn = 'activities'; // Sort by number of activities by default
let currentSortOrder = 'desc';        // Descending order initially
let searchFilter = '';
let countdownInterval = null;
const refreshRateMs = 5000;

document.addEventListener('DOMContentLoaded', () => {
    // Start initial load and run loop
    fetchStats();
    
    // Set up search field listener
    const searchInput = document.getElementById('search-input');
    searchInput.addEventListener('input', (e) => {
        searchFilter = e.target.value.trim().toLowerCase();
        renderTable();
    });

    // Set up table header sort listeners
    const headers = document.querySelectorAll('th.sortable');
    headers.forEach(header => {
        header.addEventListener('click', () => {
            const column = header.getAttribute('data-sort');
            
            // Toggle sort direction or switch columns
            if (currentSortColumn === column) {
                currentSortOrder = currentSortOrder === 'asc' ? 'desc' : 'asc';
            } else {
                currentSortColumn = column;
                // Default to descending for activities, ascending for rank/name
                currentSortOrder = column === 'activities' ? 'desc' : 'asc';
            }
            
            // Update UI class indicators on headers
            headers.forEach(h => {
                h.classList.remove('sorted-asc', 'sorted-desc');
            });
            header.classList.add(`sorted-${currentSortOrder}`);
            
            renderTable();
        });
    });
});

/**
 * Starts the countdown progress bar micro-animation.
 */
function startProgressBar() {
    clearInterval(countdownInterval);
    const progressBar = document.getElementById('countdown-progress');
    const startTime = Date.now();
    
    countdownInterval = setInterval(() => {
        const elapsed = Date.now() - startTime;
        let percent = 100 - (elapsed / refreshRateMs) * 100;
        
        if (percent < 0) {
            percent = 0;
            clearInterval(countdownInterval);
        }
        progressBar.style.width = `${percent}%`;
    }, 50); // Updates progress bar every 50ms for smooth scaling
}

/**
 * Fetches latest data from the backend.
 */
function fetchStats() {
    startProgressBar();
    
    fetch('/api/stats')
        .then(response => {
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return response.json();
        })
        .then(data => {
            updateStatusBadge(data.status, data.error_message);
            
            if (data.status === 'success' || data.status === 'stale') {
                rawData = data.data || [];
                updateMetrics(rawData);
                renderTable();
                
                if (data.last_updated) {
                    document.getElementById('last-updated').textContent = formatTimestamp(data.last_updated);
                }
            } else if (data.status === 'error') {
                showTableMessage(`خطأ في جلب البيانات: ${data.error_message || 'تعذر الاتصال بالنظام'}`);
            }
        })
        .catch(err => {
            console.error('Error fetching stats:', err);
            updateStatusBadge('offline', err.message);
            showTableMessage('تعذر الاتصال بالخادم المحلي. يرجى التحقق من تشغيل التطبيق.');
        })
        .finally(() => {
            // Queue next fetch in exactly 5 seconds
            setTimeout(fetchStats, refreshRateMs);
        });
}

/**
 * Formats database timestamp to local 12-hour clock
 */
function formatTimestamp(timestampStr) {
    try {
        // Expected format: YYYY-MM-DD HH:MM:SS
        const parts = timestampStr.split(' ');
        if (parts.length === 2) {
            return parts[1]; // Return just the HH:MM:SS part
        }
        return timestampStr;
    } catch (e) {
        return timestampStr;
    }
}

/**
 * Updates status badge indicators and warnings.
 */
function updateStatusBadge(status, errorMessage) {
    const badge = document.getElementById('status-badge');
    const text = document.getElementById('status-text');
    const alertBanner = document.getElementById('alert-banner');
    const alertMessage = document.getElementById('alert-message');

    // Reset status classes
    badge.className = 'status-badge';
    alertBanner.classList.add('hidden');

    if (status === 'success') {
        badge.classList.add('status-connected');
        text.textContent = 'متصل بالنظام';
    } else if (status === 'stale') {
        badge.classList.add('status-stale-state');
        text.textContent = 'البيانات قديمة';
        alertBanner.classList.remove('hidden');
        alertMessage.textContent = 'نظام التقديم غير متاح حالياً. تم عرض آخر بيانات محفوظة بنجاح.';
    } else if (status === 'error') {
        badge.classList.add('status-error-state');
        text.textContent = 'خطأ اتصال';
        alertBanner.classList.remove('hidden');
        alertMessage.textContent = `فشل جلب البيانات: ${errorMessage || 'خطأ غير معروف'}`;
    } else { // offline (fetch failed)
        badge.classList.add('status-error-state');
        text.textContent = 'غير متصل';
        alertBanner.classList.remove('hidden');
        alertMessage.textContent = 'تعذر الاتصال بخادم التطبيق المحلي. يرجى التحقق من لوحة التحكم.';
    }
}

/**
 * Updates dashboard metric counters.
 */
function updateMetrics(data) {
    // 1. Total Universities
    const totalUniv = data.length;
    document.getElementById('metric-total-univ').textContent = formatNumber(totalUniv);

    // 2. Total Activities
    const totalActivities = data.reduce((acc, curr) => {
        const val = parseInt(curr.activities);
        return acc + (isNaN(val) ? 0 : val);
    }, 0);
    document.getElementById('metric-total-activities').textContent = formatNumber(totalActivities);

    // Sort a copy of data by activities descending to ensure correct relative rankings
    const sortedByActivities = [...data].sort((a, b) => {
        const actA = parseInt(a.activities) || 0;
        const actB = parseInt(b.activities) || 0;
        return actB - actA;
    });

    // Find Zagazig National University specifically (matching 'الزقازيق' and 'اهلي' to separate from public university)
    const znuIndex = sortedByActivities.findIndex(univ => univ.name.includes('الزقازيق') && (univ.name.includes('اهلي') || univ.name.includes('أهلي')));
    const znuData = znuIndex !== -1 ? sortedByActivities[znuIndex] : null;

    if (znuData) {
        document.getElementById('metric-znu-rank').textContent = `#${znuData.rank}`;
        document.getElementById('metric-znu-activities').textContent = formatNumber(znuData.activities);

        // Calculate gap to the university directly above ZNU
        if (znuIndex > 0) {
            const competitor = sortedByActivities[znuIndex - 1];
            const znuAct = parseInt(znuData.activities) || 0;
            const compAct = parseInt(competitor.activities) || 0;
            const gap = compAct - znuAct + 1; // +1 to exceed / bypass

            document.getElementById('metric-znu-gap').textContent = formatNumber(gap);
            document.getElementById('metric-gap-subtitle').textContent = `لتخطي ${competitor.name} (${formatNumber(compAct)} نشاط)`;
        } else {
            // ZNU is at rank 1 (index 0)
            document.getElementById('metric-znu-gap').textContent = '0';
            document.getElementById('metric-gap-subtitle').textContent = 'الزقازيق الأهلية في الصدارة! 🎉';
        }
    } else {
        document.getElementById('metric-znu-rank').textContent = 'غير مدرج';
        document.getElementById('metric-znu-activities').textContent = '-';
        document.getElementById('metric-znu-gap').textContent = '-';
        document.getElementById('metric-gap-subtitle').textContent = 'الجامعة غير مدرجة في البيانات';
    }
}

/**
 * Formats raw numbers to English locale string
 */
function formatNumber(num) {
    if (num === null || num === undefined || isNaN(num)) return '-';
    return Number(num).toLocaleString('en-US');
}

/**
 * Renders table rows based on current sorting, filtering, and highlighting rules.
 */
function renderTable() {
    const tbody = document.getElementById('table-body');
    tbody.innerHTML = '';

    // Apply local search filtering
    let filtered = rawData;
    if (searchFilter) {
        filtered = rawData.filter(univ => 
            univ.name.toLowerCase().includes(searchFilter) || 
            String(univ.rank).includes(searchFilter)
        );
    }

    if (filtered.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="3" class="empty-state">
                    <i class="fa-regular fa-folder-open" style="font-size: 2rem; margin-bottom: 0.5rem; display: block; opacity: 0.5;"></i>
                    لم يتم العثور على جامعات تطابق البحث.
                </td>
            </tr>
        `;
        return;
    }

    // Apply sorting
    const sorted = [...filtered].sort((a, b) => {
        let valA = a[currentSortColumn];
        let valB = b[currentSortColumn];

        if (currentSortColumn === 'rank' || currentSortColumn === 'activities') {
            const numA = parseInt(valA) || 0;
            const numB = parseInt(valB) || 0;
            return currentSortOrder === 'asc' ? numA - numB : numB - numA;
        }

        // Arabic string locale sorting
        valA = String(valA || '');
        valB = String(valB || '');
        return currentSortOrder === 'asc' 
            ? valA.localeCompare(valB, 'ar') 
            : valB.localeCompare(valA, 'ar');
    });

    // Output table rows
    sorted.forEach(row => {
        const tr = document.createElement('tr');
        
        // Match Zagazig National University specifically (matching 'الزقازيق' and 'اهلي' to separate from public university)
        const isZNU = row.name.includes('الزقازيق') && (row.name.includes('اهلي') || row.name.includes('أهلي'));
        if (isZNU) {
            tr.classList.add('znu-row');
        }

        tr.innerHTML = `
            <td class="font-inter">${row.rank}</td>
            <td class="text-right">
                ${isZNU ? '<i class="fa-solid fa-star" style="color: var(--accent-gold); margin-left: 0.4rem;"></i>' : ''}
                ${row.name}
            </td>
            <td class="font-inter">${Number(row.activities).toLocaleString('en-US')}</td>
        `;
        tbody.appendChild(tr);
    });
}

/**
 * Shows an informational/error message in the table container.
 */
function showTableMessage(msg) {
    const tbody = document.getElementById('table-body');
    tbody.innerHTML = `
        <tr>
            <td colspan="3" class="empty-state">
                <p>${msg}</p>
            </td>
        </tr>
    `;
}
