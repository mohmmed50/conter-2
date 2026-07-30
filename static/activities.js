// Activities feature: browsing + detail modals for Zagazig National University.
// Triggered by clicking the highlighted ZNU row in the main rankings table.

const activitiesState = {
    start: 0,
    length: 50,
    search: '',
    recordsTotal: 0,
};

let activitySearchDebounce = null;

// Prefetch cache: keyed by `${search}::${start}` -> the page payload, so the next
// page is usually already sitting in memory by the time the user clicks "next".
const activitiesPageCache = new Map();

function cacheKey(search, start) {
    return `${search}::${start}`;
}

function fetchActivitiesPage(start, length, search) {
    const params = new URLSearchParams({ start, length, search });
    return fetch(`/api/university-activities?${params.toString()}`).then((r) => r.json());
}

function prefetchNextPage() {
    const nextStart = activitiesState.start + activitiesState.length;
    if (activitiesState.recordsTotal && nextStart >= activitiesState.recordsTotal) return;

    const key = cacheKey(activitiesState.search, nextStart);
    if (activitiesPageCache.has(key)) return;

    fetchActivitiesPage(nextStart, activitiesState.length, activitiesState.search)
        .then((data) => {
            if (data.status === 'success') {
                activitiesPageCache.set(key, data);
            }
        })
        .catch(() => {
            // Silent failure: prefetching is a background optimization, the user
            // will simply get a normal (non-cached) fetch if this didn't work out.
        });
}

// ---- Flagged-for-deletion list (stored client-side only, in this browser) ----
const FLAGGED_STORAGE_KEY = 'znu_flagged_for_deletion';

function getFlaggedList() {
    try {
        return JSON.parse(localStorage.getItem(FLAGGED_STORAGE_KEY)) || [];
    } catch (e) {
        return [];
    }
}

function saveFlaggedList(list) {
    localStorage.setItem(FLAGGED_STORAGE_KEY, JSON.stringify(list));
    updateFlaggedBadge();
}

function isFlagged(activityId) {
    return getFlaggedList().some((a) => a.id === activityId);
}

function toggleFlag(activity) {
    const list = getFlaggedList();
    const idx = list.findIndex((a) => a.id === activity.id);
    if (idx >= 0) {
        list.splice(idx, 1);
    } else {
        list.push(activity);
    }
    saveFlaggedList(list);
    return idx < 0; // true = just flagged, false = just unflagged
}

function removeFlagged(activityId) {
    saveFlaggedList(getFlaggedList().filter((a) => a.id !== activityId));
    renderFlaggedTable();
}

function updateFlaggedBadge() {
    const count = getFlaggedList().length;
    const badge = document.getElementById('flagged-count-badge');
    if (badge) badge.textContent = count;
}

function openFlaggedModal() {
    document.getElementById('flagged-modal').classList.remove('hidden');
    document.body.classList.add('modal-open');
    renderFlaggedTable();
}

function closeFlaggedModal() {
    document.getElementById('flagged-modal').classList.add('hidden');
    document.body.classList.remove('modal-open');
}

function renderFlaggedTable() {
    const list = getFlaggedList();
    const tbody = document.getElementById('flagged-table-body');
    document.getElementById('flagged-count-label').textContent = `إجمالي المحدد للحذف: ${list.length}`;

    if (!list.length) {
        tbody.innerHTML = `<tr><td colspan="4" class="empty-state">لسه مفيش أي نشاط محدد للحذف.</td></tr>`;
        return;
    }

    tbody.innerHTML = list.map((a) => `
        <tr>
            <td class="text-right">${escapeHtml(a.name || '-')}</td>
            <td class="font-inter">${escapeHtml(a.id)}</td>
            <td class="font-inter">${escapeHtml(String(a.students ?? '-'))}</td>
            <td><button class="page-btn page-btn-danger remove-flag-btn" data-id="${escapeHtml(a.id)}"><i class="fa-solid fa-xmark"></i></button></td>
        </tr>
    `).join('');

    tbody.querySelectorAll('.remove-flag-btn').forEach((btn) => {
        btn.addEventListener('click', () => removeFlagged(btn.dataset.id));
    });
}

function exportFlaggedCsv() {
    const list = getFlaggedList();
    if (!list.length) return;

    const header = ['activity_id', 'name', 'start_date', 'end_date', 'students'];
    const escapeCsv = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [header.join(',')];
    list.forEach((a) => {
        lines.push([a.id, a.name, a.start_date, a.end_date, a.students].map(escapeCsv).join(','));
    });

    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `activities_to_delete_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

document.addEventListener('DOMContentLoaded', () => {
    const activitiesModal = document.getElementById('activities-modal');
    const detailModal = document.getElementById('activity-detail-modal');
    const flaggedModal = document.getElementById('flagged-modal');

    updateFlaggedBadge();

    document.getElementById('activities-modal-close').addEventListener('click', closeActivitiesModal);
    document.getElementById('activity-detail-modal-close').addEventListener('click', closeActivityDetailModal);
    document.getElementById('flagged-modal-close').addEventListener('click', closeFlaggedModal);
    document.getElementById('open-flagged-btn').addEventListener('click', openFlaggedModal);
    document.getElementById('export-flagged-btn').addEventListener('click', exportFlaggedCsv);
    document.getElementById('clear-flagged-btn').addEventListener('click', () => {
        if (confirm('هل أنت متأكد من إفراغ قائمة الأنشطة المحددة للحذف بالكامل؟')) {
            saveFlaggedList([]);
            renderFlaggedTable();
        }
    });

    activitiesModal.addEventListener('click', (e) => {
        if (e.target === activitiesModal) closeActivitiesModal();
    });
    detailModal.addEventListener('click', (e) => {
        if (e.target === detailModal) closeActivityDetailModal();
    });
    flaggedModal.addEventListener('click', (e) => {
        if (e.target === flaggedModal) closeFlaggedModal();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (!detailModal.classList.contains('hidden')) closeActivityDetailModal();
        else if (!flaggedModal.classList.contains('hidden')) closeFlaggedModal();
        else if (!activitiesModal.classList.contains('hidden')) closeActivitiesModal();
    });

    document.getElementById('activities-prev-btn').addEventListener('click', () => {
        if (activitiesState.start - activitiesState.length >= 0) {
            activitiesState.start -= activitiesState.length;
            loadActivities();
        }
    });

    document.getElementById('activities-next-btn').addEventListener('click', () => {
        if (activitiesState.start + activitiesState.length < activitiesState.recordsTotal) {
            activitiesState.start += activitiesState.length;
            loadActivities();
        }
    });

    document.getElementById('activity-search-input').addEventListener('input', (e) => {
        clearTimeout(activitySearchDebounce);
        const value = e.target.value.trim();
        activitySearchDebounce = setTimeout(() => {
            activitiesState.search = value;
            activitiesState.start = 0;
            activitiesPageCache.clear();
            loadActivities();
        }, 450);
    });
});

function openActivitiesModal() {
    document.getElementById('activities-modal').classList.remove('hidden');
    document.body.classList.add('modal-open');
    activitiesState.start = 0;
    activitiesState.search = '';
    activitiesPageCache.clear();
    document.getElementById('activity-search-input').value = '';
    loadActivities();
}

function closeActivitiesModal() {
    document.getElementById('activities-modal').classList.add('hidden');
    document.body.classList.remove('modal-open');
}

function openActivityDetailModal() {
    document.getElementById('activity-detail-modal').classList.remove('hidden');
}

function closeActivityDetailModal() {
    document.getElementById('activity-detail-modal').classList.add('hidden');
}

function loadActivities() {
    const tbody = document.getElementById('activities-table-body');
    const key = cacheKey(activitiesState.search, activitiesState.start);
    const cached = activitiesPageCache.get(key);

    if (cached) {
        // Already prefetched: render instantly, no spinner, no network round-trip.
        activitiesPageCache.delete(key);
        applyActivitiesPage(cached);
        return;
    }

    tbody.innerHTML = `<tr><td colspan="4" class="loading-state"><div class="spinner"></div><p>جاري جلب الأنشطة من النظام...</p></td></tr>`;

    fetchActivitiesPage(activitiesState.start, activitiesState.length, activitiesState.search)
        .then((data) => {
            if (data.status !== 'success') {
                tbody.innerHTML = `<tr><td colspan="4" class="empty-state">تعذر جلب الأنشطة: ${escapeHtml(data.error_message || 'خطأ غير معروف')}</td></tr>`;
                return;
            }
            applyActivitiesPage(data);
        })
        .catch((err) => {
            tbody.innerHTML = `<tr><td colspan="4" class="empty-state">تعذر الاتصال بالخادم: ${escapeHtml(err.message)}</td></tr>`;
        });
}

function applyActivitiesPage(data) {
    activitiesState.recordsTotal = data.recordsFiltered || data.recordsTotal || 0;
    renderActivitiesTable(data.data || []);
    updateActivitiesPaginationInfo();
    prefetchNextPage();
}

function renderActivitiesTable(rows) {
    const tbody = document.getElementById('activities-table-body');
    tbody.innerHTML = '';

    if (!rows.length) {
        tbody.innerHTML = `
            <tr>
                <td colspan="4" class="empty-state">
                    <i class="fa-regular fa-folder-open" style="font-size: 1.8rem; margin-bottom: 0.5rem; display: block; opacity: 0.5;"></i>
                    لا توجد أنشطة مطابقة.
                </td>
            </tr>`;
        return;
    }

    rows.forEach((row) => {
        const tr = document.createElement('tr');
        tr.classList.add('clickable-row');
        tr.title = 'اضغط لعرض تفاصيل النشاط';
        tr.innerHTML = `
            <td class="text-right">${escapeHtml(row.name || '-')}</td>
            <td class="font-inter">${escapeHtml(row.start_date || '-')}</td>
            <td class="font-inter">${escapeHtml(row.end_date || '-')}</td>
            <td class="font-inter">${escapeHtml(String(row.students ?? '-'))}</td>
        `;
        tr.addEventListener('click', () => openActivityDetail(row.id));
        tbody.appendChild(tr);
    });
}

function updateActivitiesPaginationInfo() {
    const { start, length, recordsTotal } = activitiesState;
    const from = recordsTotal === 0 ? 0 : start + 1;
    const to = Math.min(start + length, recordsTotal);
    document.getElementById('activities-page-info').textContent = `${from}-${to} من ${recordsTotal.toLocaleString('en-US')}`;
    document.getElementById('activities-count-label').textContent = `إجمالي الأنشطة: ${recordsTotal.toLocaleString('en-US')}`;

    document.getElementById('activities-prev-btn').disabled = start <= 0;
    document.getElementById('activities-next-btn').disabled = start + length >= recordsTotal;
}

function openActivityDetail(activityId) {
    openActivityDetailModal();
    const body = document.getElementById('activity-detail-body');
    body.innerHTML = `<div class="loading-state"><div class="spinner"></div><p>جاري جلب التفاصيل...</p></div>`;

    fetch(`/api/activity/${encodeURIComponent(activityId)}`)
        .then((r) => r.json())
        .then((res) => {
            if (res.status !== 'success') {
                body.innerHTML = `<div class="empty-state">تعذر جلب التفاصيل: ${escapeHtml(res.error_message || 'النشاط غير موجود')}</div>`;
                return;
            }
            renderActivityDetail(res.data);
        })
        .catch((err) => {
            body.innerHTML = `<div class="empty-state">تعذر الاتصال بالخادم: ${escapeHtml(err.message)}</div>`;
        });
}

function renderActivityDetail(d) {
    const body = document.getElementById('activity-detail-body');

    const field = (label, value) => `
        <div class="detail-field">
            <span class="detail-label">${label}</span>
            <span class="detail-value">${escapeHtml(value && String(value).trim() ? value : '-')}</span>
        </div>`;

    let attachmentsHtml = '<span class="detail-value">لا يوجد مرفقات</span>';
    if (d.attachments && d.attachments.length) {
        attachmentsHtml = d.attachments
            .map((a) => `<a href="${escapeHtml(a.href)}" target="_blank" rel="noopener" class="attachment-link"><i class="fa-solid fa-paperclip"></i> ${escapeHtml(a.label)}</a>`)
            .join('');
    }

    body.innerHTML = `
        <h3 class="detail-activity-title">${escapeHtml(d.name || '-')}</h3>

        <div class="detail-grid">
            ${field('الجامعة', d.university)}
            ${field('الكلية', d.college)}
            ${field('طبيعة النشاط', d.nature)}
            ${field('نوع النشاط', d.type)}
            ${field('حالة النشاط', d.status)}
            ${field('تاريخ بداية النشاط', d.start_date)}
            ${field('تاريخ نهاية النشاط', d.end_date)}
            ${field('تم التكليف من قبل', d.assigned_by)}
        </div>

        <div class="detail-section">
            <h4><i class="fa-solid fa-align-right"></i> وصف النشاط</h4>
            <p class="detail-description">${escapeHtml(d.description && d.description.trim() ? d.description : 'لا يوجد وصف')}</p>
        </div>

        <div class="detail-section">
            <h4><i class="fa-solid fa-users"></i> الطلاب</h4>
            <div class="students-grid">
                <div class="student-stat"><span class="num font-inter">${escapeHtml(String(d.students_expatriates ?? '-'))}</span><span class="lbl">وافدين</span></div>
                <div class="student-stat"><span class="num font-inter">${escapeHtml(String(d.students_egyptians ?? '-'))}</span><span class="lbl">مصريين</span></div>
                <div class="student-stat"><span class="num font-inter">${escapeHtml(String(d.students_special_needs ?? '-'))}</span><span class="lbl">ذوي الاحتياجات</span></div>
                <div class="student-stat student-stat-total"><span class="num font-inter">${escapeHtml(String(d.students_total ?? '-'))}</span><span class="lbl">الإجمالي</span></div>
            </div>
        </div>

        <div class="detail-section">
            <h4><i class="fa-solid fa-paperclip"></i> المرفقات</h4>
            <div class="attachments-list">${attachmentsHtml}</div>
        </div>

        <div class="detail-delete-section">
            <button id="flag-delete-btn" class="flag-delete-btn"></button>
        </div>
    `;

    const flagBtn = document.getElementById('flag-delete-btn');
    const flaggedActivity = {
        id: d.id,
        name: d.name,
        start_date: d.start_date,
        end_date: d.end_date,
        students: d.students_total,
    };

    const paintFlagButton = () => {
        if (isFlagged(d.id)) {
            flagBtn.classList.add('flagged');
            flagBtn.innerHTML = '<i class="fa-solid fa-flag-checkered"></i> محدد للحذف — اضغط لإلغاء التحديد';
        } else {
            flagBtn.classList.remove('flagged');
            flagBtn.innerHTML = '<i class="fa-regular fa-flag"></i> هل تود حذف هذا النشاط؟';
        }
    };

    flagBtn.addEventListener('click', () => {
        toggleFlag(flaggedActivity);
        paintFlagButton();
    });

    paintFlagButton();
}

function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
