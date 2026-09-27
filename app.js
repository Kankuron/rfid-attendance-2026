document.addEventListener("DOMContentLoaded", function () {

    /* =====================================================
       SUPABASE CONFIG
    ===================================================== */

    const SUPABASE_URL =
        "https://zepbgjlliklvwyipahin.supabase.co";

    const SUPABASE_API =
        SUPABASE_URL + "/rest/v1";

    const SUPABASE_KEY =
        "sb_publishable_HJYQXc8ZnQMJBhxHzxAp6Q_dMtY1NwW";


    const SESSION_KEY =
        "attendance_admin_session";


    /* =====================================================
       SESSION GUARD
       This mirrors the inline guard script in index.html.
       That inline script prevents the dashboard from flashing
       on screen before a redirect; this one is the safety net
       in case app.js somehow runs without it (and it's what
       supabaseRequest() actually uses for the Authorization
       header on every request).
    ===================================================== */

    function readStoredSession() {

        try {

            const raw =
                localStorage.getItem(SESSION_KEY) ||
                sessionStorage.getItem(SESSION_KEY);

            return raw ? JSON.parse(raw) : null;

        } catch (error) {

            return null;

        }

    }


    function isSessionValid(session) {

        return (
            session &&
            session.access_token &&
            session.expires_at &&
            session.expires_at > Date.now()
        );

    }


    function clearStoredSessionAndRedirect() {

        localStorage.removeItem(SESSION_KEY);

        sessionStorage.removeItem(SESSION_KEY);

        window.location.href = "login.html";

    }


    let currentSession =
        readStoredSession();


    if (!isSessionValid(currentSession)) {

        clearStoredSessionAndRedirect();

        return;

    }


    /* =====================================================
       SESSION REFRESH
       Access tokens expire (commonly after 1 hour). Since the
       dashboard auto-refreshes data every 30 seconds and may
       stay open for a full school day, requests need to renew
       the token proactively rather than failing after an hour.
    ===================================================== */

    async function refreshCurrentSession() {

        const response =
            await fetch(
                SUPABASE_URL +
                "/auth/v1/token?grant_type=refresh_token",
                {
                    method: "POST",

                    headers: {
                        "apikey": SUPABASE_KEY,

                        "Content-Type":
                            "application/json"
                    },

                    body: JSON.stringify({
                        refresh_token:
                            currentSession.refresh_token
                    })
                }
            );


        if (!response.ok) {

            throw new Error(
                "Session refresh failed"
            );

        }


        const data =
            await response.json();


        const updated = {
            access_token:
                data.access_token,

            refresh_token:
                data.refresh_token,

            expires_at:
                Date.now() +
                (data.expires_in * 1000),

            email:
                currentSession.email
        };


        /* Write back to whichever storage currently holds
           the session (localStorage for "Remember me",
           sessionStorage otherwise). */

        if (localStorage.getItem(SESSION_KEY)) {

            localStorage.setItem(
                SESSION_KEY,
                JSON.stringify(updated)
            );

        } else {

            sessionStorage.setItem(
                SESSION_KEY,
                JSON.stringify(updated)
            );

        }


        currentSession = updated;

        return currentSession;

    }


    async function ensureFreshSession() {

        const oneMinute = 60 * 1000;


        if (
            currentSession.expires_at - Date.now() <
            oneMinute
        ) {

            try {

                await refreshCurrentSession();

            } catch (error) {

                console.error(
                    "Unable to refresh session:",
                    error
                );

                clearStoredSessionAndRedirect();

                throw error;

            }

        }

    }


    const STUDENT_PHOTOS_BUCKET =
        "student-photos";


    const MAX_PHOTO_BYTES =
        2 * 1024 * 1024;


    const ALLOWED_PHOTO_TYPES = [
        "image/jpeg",
        "image/png",
        "image/webp"
    ];


    /* A plain gray circle with a simple person silhouette,
       used whenever a student has no uploaded photo. Kept
       as an inline SVG so there's no extra file dependency
       and no network request for the common case. */

    const DEFAULT_AVATAR =
        "data:image/svg+xml;utf8," +
        encodeURIComponent(
            "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'>" +
            "<circle cx='50' cy='50' r='50' fill='#e5e7eb'/>" +
            "<circle cx='50' cy='40' r='18' fill='#9ca3af'/>" +
            "<path d='M15 90 Q50 60 85 90 Z' fill='#9ca3af'/>" +
            "</svg>"
        );


    /* =====================================================
       DATA
    ===================================================== */

    let students = [];
    let sections = [];
    let attendance = [];

    let settings = {
        school_start_time: "07:30:00",
        grace_period_minutes: 10
    };

    let selectedStudentId = null;
    let selectedSectionId = null;

    let editSelectedPhotoFile = null;
    let editRemovePhotoRequested = false;

    let trendChartInstance = null;
    let distributionChartInstance = null;
    let sectionChartInstance = null;


    /* =====================================================
       SUPABASE REQUEST
    ===================================================== */

    async function supabaseRequest(endpoint, options = {}) {

        await ensureFreshSession();


        const response = await fetch(
            SUPABASE_API + "/" + endpoint,
            {
                method: options.method || "GET",

                headers: {
                    "apikey": SUPABASE_KEY,

                    "Authorization":
                        "Bearer " +
                        currentSession.access_token,

                    "Content-Type":
                        "application/json",

                    ...(options.headers || {})
                },

                body: options.body
                    ? JSON.stringify(options.body)
                    : undefined
            }
        );


        if (!response.ok) {

            const errorText =
                await response.text();

            throw new Error(
                "Supabase error " +
                response.status +
                ": " +
                errorText
            );

        }


        const text =
            await response.text();

        return text
            ? JSON.parse(text)
            : null;

    }


    /* =====================================================
       RFID NORMALIZATION
       Must match the normalization used by any ESP32/bridge
       code and the one-time cleanup already run in Supabase.
    ===================================================== */

    function normalizeRFID(uid) {

        return String(uid || "")
            .trim()
            .toUpperCase()
            .replace(/[\s-]+/g, ":");

    }


    /* =====================================================
       STUDENT PHOTO HELPERS
    ===================================================== */

    function getStudentPhotoUrl(student) {

        return (
            (student && student.profile_picture_url) ||
            DEFAULT_AVATAR
        );

    }


    function validatePhotoFile(file) {

        if (
            !ALLOWED_PHOTO_TYPES.includes(file.type)
        ) {

            return "Please choose a JPG, PNG, or WEBP image.";

        }


        if (file.size > MAX_PHOTO_BYTES) {

            return "Image must be smaller than 2MB.";

        }


        return null;

    }


    function getExtensionForType(type) {

        if (type === "image/png") {
            return "png";
        }


        if (type === "image/webp") {
            return "webp";
        }


        return "jpg";

    }


    function getPublicPhotoUrl(path) {

        return (
            SUPABASE_URL +
            "/storage/v1/object/public/" +
            STUDENT_PHOTOS_BUCKET +
            "/" +
            path
        );

    }


    /* Recovers the storage path from a previously-saved
       public URL, so we know what to delete when a photo
       is replaced or removed. */

    function extractStoragePath(url) {

        if (!url) {
            return null;
        }


        const marker =
            "/object/public/" +
            STUDENT_PHOTOS_BUCKET +
            "/";


        const index =
            url.indexOf(marker);


        if (index === -1) {
            return null;
        }


        return url
            .slice(index + marker.length)
            .split("?")[0];

    }


    async function uploadStudentPhoto(
        studentId,
        file
    ) {

        await ensureFreshSession();


        const path =
            studentId +
            "." +
            getExtensionForType(file.type);


        const response =
            await fetch(
                SUPABASE_URL +
                "/storage/v1/object/" +
                STUDENT_PHOTOS_BUCKET +
                "/" +
                path,
                {
                    method: "POST",

                    headers: {
                        "apikey": SUPABASE_KEY,

                        "Authorization":
                            "Bearer " +
                            currentSession.access_token,

                        "Content-Type": file.type,

                        "x-upsert": "true"
                    },

                    body: file
                }
            );


        if (!response.ok) {

            const errorText =
                await response.text();

            throw new Error(
                "Storage upload error " +
                response.status +
                ": " +
                errorText
            );

        }


        /* Cache-bust so the browser doesn't keep showing an
           old cached image at the same path after a replace. */

        return (
            getPublicPhotoUrl(path) +
            "?t=" +
            Date.now()
        );

    }


    async function deleteStudentPhoto(path) {

        if (!path) {
            return;
        }


        await ensureFreshSession();


        const response =
            await fetch(
                SUPABASE_URL +
                "/storage/v1/object/" +
                STUDENT_PHOTOS_BUCKET,
                {
                    method: "DELETE",

                    headers: {
                        "apikey": SUPABASE_KEY,

                        "Authorization":
                            "Bearer " +
                            currentSession.access_token,

                        "Content-Type":
                            "application/json"
                    },

                    body: JSON.stringify({
                        prefixes: [path]
                    })
                }
            );


        if (!response.ok) {

            /* Best-effort: if the file is already gone or the
               delete fails, we still proceed with clearing the
               database reference rather than blocking the user. */

            console.error(
                "Storage delete error " +
                response.status
            );

        }

    }


    /* =====================================================
       MANILA DATE
    ===================================================== */

    function getManilaDate() {

        return new Intl.DateTimeFormat(
            "en-CA",
            {
                timeZone: "Asia/Manila",
                year: "numeric",
                month: "2-digit",
                day: "2-digit"
            }
        ).format(new Date());

    }


    function getSelectedDate() {

        const dateFilter =
            document.getElementById(
                "dateFilter"
            );


        if (
            dateFilter &&
            dateFilter.value
        ) {

            return dateFilter.value;

        }


        return getManilaDate();

    }


    function getSelectedDateRangeUTC() {

        const selectedDate =
            getSelectedDate();


        const start =
            new Date(
                selectedDate +
                "T00:00:00+08:00"
            );


        const end =
            new Date(
                selectedDate +
                "T23:59:59.999+08:00"
            );


        return {
            start: start.toISOString(),
            end: end.toISOString()
        };

    }


    /* =====================================================
       FORMAT DATE
    ===================================================== */

    function formatDateTime(dateString) {

        if (!dateString) {
            return "—";
        }


        return new Intl.DateTimeFormat(
            "en-PH",
            {
                timeZone: "Asia/Manila",
                dateStyle: "medium",
                timeStyle: "short"
            }
        ).format(
            new Date(dateString)
        );

    }


    /* =====================================================
       ESCAPE HTML
    ===================================================== */

    function escapeHTML(value) {

        if (
            value === null ||
            value === undefined
        ) {

            return "";

        }


        return String(value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");

    }


    /* =====================================================
       STATUS BADGE CLASS
       Maps the real "status" column value (Present / Late)
       to the matching CSS badge class. Falls back to
       "present" only when status is genuinely missing,
       never overrides a real Late value.
    ===================================================== */

    function statusBadgeClass(status) {

        const value =
            (status || "Present")
                .toString()
                .toLowerCase();


        if (
            value === "late" ||
            value === "absent"
        ) {

            return value;

        }


        return "present";

    }


    /* =====================================================
       LOAD STUDENTS
    ===================================================== */

    async function loadStudents() {

        students =
            await supabaseRequest(
                "students" +
                "?select=id,student_id,name,section_id,rfid_uid,active,created_at,profile_picture_url" +
                "&order=name.asc"
            );

    }


    /* =====================================================
       LOAD SECTIONS
    ===================================================== */

    async function loadSections() {

        sections =
            await supabaseRequest(
                "sections" +
                "?select=id,section_name,grade_level,created_at" +
                "&order=section_name.asc"
            );

    }


    /* =====================================================
       LOAD ATTENDANCE
    ===================================================== */

    async function loadAttendance() {

        const range =
            getSelectedDateRangeUTC();


        attendance =
            await supabaseRequest(
                "attendance" +
                "?select=id,student_id,scan_time,scanner_location,created_at,status" +
                "&scan_time=gte." +
                encodeURIComponent(range.start) +
                "&scan_time=lte." +
                encodeURIComponent(range.end) +
                "&order=scan_time.desc"
            );

    }


    /* =====================================================
       LOAD SETTINGS
    ===================================================== */

    async function loadSettings() {

        try {

            const result =
                await supabaseRequest(
                    "school_settings" +
                    "?select=school_start_time,grace_period_minutes" +
                    "&id=eq.1"
                );


            if (
                result &&
                result.length > 0
            ) {

                settings = {
                    school_start_time:
                        result[0].school_start_time,

                    grace_period_minutes:
                        result[0].grace_period_minutes
                };

            }


        } catch (error) {

            console.error(
                "Load settings error:",
                error
            );

            /* Fall back to the default in-memory settings
               so the dashboard still functions if this
               table isn't reachable for any reason. */

        }

    }


    /* =====================================================
       POPULATE SETTINGS FORM
    ===================================================== */

    function populateSettingsForm() {

        const startInput =
            document.getElementById(
                "schoolStartTime"
            );


        const graceInput =
            document.getElementById(
                "gracePeriodMinutes"
            );


        const preview =
            document.getElementById(
                "settingsPreview"
            );


        if (startInput) {

            /* Supabase returns "07:30:00", <input type="time">
               wants "07:30" */

            startInput.value =
                (settings.school_start_time || "07:30:00")
                    .slice(0, 5);

        }


        if (graceInput) {

            graceInput.value =
                settings.grace_period_minutes ?? 10;

        }


        if (preview) {

            preview.textContent =
                "Currently: scans at or before " +
                (settings.school_start_time || "07:30:00").slice(0, 5) +
                " + " +
                (settings.grace_period_minutes ?? 10) +
                " minute(s) grace are marked Present. Anything later is Late.";

        }

    }


    /* =====================================================
       SAVE SETTINGS
    ===================================================== */

    async function saveSettings() {

        const startInput =
            document.getElementById(
                "schoolStartTime"
            );


        const graceInput =
            document.getElementById(
                "gracePeriodMinutes"
            );


        if (
            !startInput ||
            !graceInput
        ) {

            return;

        }


        const newStart =
            startInput.value;


        const newGrace =
            Number(graceInput.value);


        if (!newStart) {

            alert(
                "Please set the school start time."
            );

            return;

        }


        if (
            !Number.isFinite(newGrace) ||
            newGrace < 0 ||
            newGrace > 180
        ) {

            alert(
                "Grace period must be a number between 0 and 180 minutes."
            );

            return;

        }


        try {

            showToast(
                "Saving schedule..."
            );


            await supabaseRequest(
                "school_settings?id=eq.1",
                {
                    method: "PATCH",

                    body: {
                        school_start_time:
                            newStart + ":00",

                        grace_period_minutes:
                            newGrace
                    },

                    headers: {
                        "Prefer":
                            "return=minimal"
                    }
                }
            );


            await loadSettings();


            populateSettingsForm();


            showToast(
                "Attendance schedule updated successfully."
            );


        } catch (error) {

            console.error(
                "Save settings error:",
                error
            );


            alert(
                "Unable to save the schedule.\n\n" +
                error.message
            );

        }

    }


    /* =====================================================
       ANALYTICS DATE RANGE
       Ranges are calculated using the Asia/Manila calendar
       day as a plain date (no time-of-day), then arithmetic
       is done in UTC purely as calendar math. This avoids
       any dependency on the admin's own browser timezone,
       which the project rules explicitly warn against.
    ===================================================== */

    function parseDateOnlyUTC(dateString) {

        const parts =
            dateString.split("-");


        return new Date(
            Date.UTC(
                Number(parts[0]),
                Number(parts[1]) - 1,
                Number(parts[2])
            )
        );

    }


    function formatDateOnlyUTC(dateObject) {

        const year =
            dateObject.getUTCFullYear();

        const month =
            String(
                dateObject.getUTCMonth() + 1
            ).padStart(2, "0");

        const day =
            String(
                dateObject.getUTCDate()
            ).padStart(2, "0");


        return (
            year + "-" + month + "-" + day
        );

    }


    function getAnalyticsRangeDates() {

        const rangeSelect =
            document.getElementById(
                "analyticsRange"
            );


        const rangeType =
            rangeSelect
                ? rangeSelect.value
                : "week";


        const todayManila =
            getManilaDate();


        const todayUTC =
            parseDateOnlyUTC(todayManila);


        if (rangeType === "today") {

            return {
                startDate: todayManila,
                endDate: todayManila
            };

        }


        if (rangeType === "week") {

            /* Monday as the start of the school week.
               getUTCDay() here is pure calendar math
               (0=Sun..6=Sat), not affected by any
               timezone offset. */

            const dayOfWeek =
                todayUTC.getUTCDay();

            const diffToMonday =
                dayOfWeek === 0
                    ? 6
                    : dayOfWeek - 1;

            const monday =
                new Date(todayUTC);

            monday.setUTCDate(
                todayUTC.getUTCDate() -
                diffToMonday
            );


            return {
                startDate:
                    formatDateOnlyUTC(monday),

                endDate:
                    todayManila
            };

        }


        if (rangeType === "month") {

            const firstOfMonth =
                new Date(
                    Date.UTC(
                        todayUTC.getUTCFullYear(),
                        todayUTC.getUTCMonth(),
                        1
                    )
                );


            return {
                startDate:
                    formatDateOnlyUTC(firstOfMonth),

                endDate:
                    todayManila
            };

        }


        /* custom */

        const startInput =
            document.getElementById(
                "analyticsStartDate"
            );


        const endInput =
            document.getElementById(
                "analyticsEndDate"
            );


        return {
            startDate:
                (startInput && startInput.value) ||
                todayManila,

            endDate:
                (endInput && endInput.value) ||
                todayManila
        };

    }


    function toggleCustomDateInputs() {

        const rangeSelect =
            document.getElementById(
                "analyticsRange"
            );


        const isCustom =
            rangeSelect &&
            rangeSelect.value === "custom";


        document
            .querySelectorAll(
                ".analytics-custom-date"
            )
            .forEach(
                function (input) {

                    input.classList.toggle(
                        "hidden",
                        !isCustom
                    );

                }
            );

    }


    /* =====================================================
       LOAD ANALYTICS DATA
    ===================================================== */

    async function loadAnalyticsAttendance(
        startDate,
        endDate
    ) {

        const start =
            new Date(
                startDate + "T00:00:00+08:00"
            ).toISOString();


        const end =
            new Date(
                endDate + "T23:59:59.999+08:00"
            ).toISOString();


        return await supabaseRequest(
            "attendance" +
            "?select=student_id,school_date,status" +
            "&scan_time=gte." +
            encodeURIComponent(start) +
            "&scan_time=lte." +
            encodeURIComponent(end) +
            "&order=school_date.asc"
        );

    }


    /* =====================================================
       COMPUTE ANALYTICS
       All figures are derived only from real attendance
       rows and the current active-student list — no
       simulated/demo data.
    ===================================================== */

    function computeAnalytics(
        records,
        sectionFilterId
    ) {

        const activeStudents =
            students.filter(
                function (student) {

                    const isActive =
                        student.active !== false;


                    const matchesSection =
                        !sectionFilterId ||
                        String(student.section_id) ===
                        String(sectionFilterId);


                    return (
                        isActive &&
                        matchesSection
                    );

                }
            );


        const activeStudentIds =
            new Set(
                activeStudents.map(
                    function (student) {

                        return String(student.id);

                    }
                )
            );


        const relevantRecords =
            records.filter(
                function (record) {

                    return activeStudentIds.has(
                        String(record.student_id)
                    );

                }
            );


        const schoolDays =
            new Set(
                relevantRecords.map(
                    function (record) {

                        return record.school_date;

                    }
                )
            );


        const dayCount =
            schoolDays.size;


        let present = 0;
        let late = 0;


        const dailyMap = {};


        relevantRecords.forEach(
            function (record) {

                if (record.status === "Late") {

                    late += 1;

                } else {

                    present += 1;

                }


                if (!dailyMap[record.school_date]) {

                    dailyMap[record.school_date] = {
                        present: 0,
                        late: 0
                    };

                }


                if (record.status === "Late") {

                    dailyMap[record.school_date].late += 1;

                } else {

                    dailyMap[record.school_date].present += 1;

                }

            }
        );


        const expectedRecords =
            activeStudents.length * dayCount;


        const absences =
            Math.max(
                expectedRecords -
                present -
                late,
                0
            );


        const rate =
            expectedRecords > 0
                ? Math.round(
                    ((present + late) / expectedRecords) * 100
                )
                : 0;


        const dailyLabels =
            Object.keys(dailyMap).sort();


        const sectionStats =
            sections.map(
                function (section) {

                    const sectionActive =
                        students.filter(
                            function (student) {

                                return (
                                    student.active !== false &&

                                    String(student.section_id) ===
                                    String(section.id)
                                );

                            }
                        );


                    const sectionActiveIds =
                        new Set(
                            sectionActive.map(
                                function (student) {

                                    return String(student.id);

                                }
                            )
                        );


                    const sectionRecords =
                        records.filter(
                            function (record) {

                                return sectionActiveIds.has(
                                    String(record.student_id)
                                );

                            }
                        );


                    const sectionExpected =
                        sectionActive.length * dayCount;


                    const sectionScanned =
                        sectionRecords.length;


                    const sectionRate =
                        sectionExpected > 0
                            ? Math.round(
                                (sectionScanned / sectionExpected) * 100
                            )
                            : 0;


                    return {
                        name: section.section_name,
                        rate: sectionRate,
                        activeCount: sectionActive.length
                    };

                }
            ).filter(
                function (item) {

                    return item.activeCount > 0;

                }
            );


        return {
            dayCount: dayCount,
            present: present,
            late: late,
            absences: absences,
            rate: rate,
            dailyLabels: dailyLabels,
            dailyMap: dailyMap,
            sectionStats: sectionStats
        };

    }


    /* =====================================================
       RENDER ANALYTICS SUMMARY
    ===================================================== */

    function renderAnalyticsSummary(stats) {

        const setText = function (id, value) {

            const el =
                document.getElementById(id);


            if (el) {

                el.textContent = value;

            }

        };


        setText(
            "analyticsDays",
            stats.dayCount
        );

        setText(
            "analyticsPresent",
            stats.present
        );

        setText(
            "analyticsLate",
            stats.late
        );

        setText(
            "analyticsAbsent",
            stats.absences
        );

        setText(
            "analyticsRate",
            stats.rate + "%"
        );

    }


    /* =====================================================
       RENDER CHARTS
       Chart instances are destroyed before redraw to avoid
       duplicate canvases when filters change.
    ===================================================== */

    function renderTrendChart(stats) {

        const canvas =
            document.getElementById(
                "trendChart"
            );


        if (
            !canvas ||
            typeof Chart === "undefined"
        ) {

            return;

        }


        if (trendChartInstance) {

            trendChartInstance.destroy();

        }


        const presentData =
            stats.dailyLabels.map(
                function (day) {

                    return stats.dailyMap[day].present;

                }
            );


        const lateData =
            stats.dailyLabels.map(
                function (day) {

                    return stats.dailyMap[day].late;

                }
            );


        trendChartInstance =
            new Chart(
                canvas,
                {
                    type: "line",

                    data: {
                        labels: stats.dailyLabels,

                        datasets: [
                            {
                                label: "Present",
                                data: presentData,
                                borderColor: "#16a34a",
                                backgroundColor: "#16a34a",
                                tension: 0.25
                            },
                            {
                                label: "Late",
                                data: lateData,
                                borderColor: "#d97706",
                                backgroundColor: "#d97706",
                                tension: 0.25
                            }
                        ]
                    },

                    options: {
                        responsive: true,
                        maintainAspectRatio: false,

                        scales: {
                            y: {
                                beginAtZero: true,

                                ticks: {
                                    precision: 0
                                }
                            }
                        }
                    }
                }
            );

    }


    function renderDistributionChart(stats) {

        const canvas =
            document.getElementById(
                "distributionChart"
            );


        if (
            !canvas ||
            typeof Chart === "undefined"
        ) {

            return;

        }


        if (distributionChartInstance) {

            distributionChartInstance.destroy();

        }


        distributionChartInstance =
            new Chart(
                canvas,
                {
                    type: "bar",

                    data: {
                        labels: [
                            "Present",
                            "Late",
                            "Absent"
                        ],

                        datasets: [
                            {
                                label: "Records",

                                data: [
                                    stats.present,
                                    stats.late,
                                    stats.absences
                                ],

                                backgroundColor: [
                                    "#16a34a",
                                    "#d97706",
                                    "#dc2626"
                                ]
                            }
                        ]
                    },

                    options: {
                        responsive: true,
                        maintainAspectRatio: false,

                        plugins: {
                            legend: {
                                display: false
                            }
                        },

                        scales: {
                            y: {
                                beginAtZero: true,

                                ticks: {
                                    precision: 0
                                }
                            }
                        }
                    }
                }
            );

    }


    function renderSectionChart(stats) {

        const canvas =
            document.getElementById(
                "sectionChart"
            );


        if (
            !canvas ||
            typeof Chart === "undefined"
        ) {

            return;

        }


        if (sectionChartInstance) {

            sectionChartInstance.destroy();

        }


        sectionChartInstance =
            new Chart(
                canvas,
                {
                    type: "bar",

                    data: {
                        labels: stats.sectionStats.map(
                            function (item) {

                                return item.name;

                            }
                        ),

                        datasets: [
                            {
                                label: "Attendance Rate (%)",

                                data: stats.sectionStats.map(
                                    function (item) {

                                        return item.rate;

                                    }
                                ),

                                backgroundColor: "#15803d"
                            }
                        ]
                    },

                    options: {
                        indexAxis: "y",

                        responsive: true,
                        maintainAspectRatio: false,

                        plugins: {
                            legend: {
                                display: false
                            }
                        },

                        scales: {
                            x: {
                                beginAtZero: true,
                                max: 100
                            }
                        }
                    }
                }
            );

    }


    /* =====================================================
       LOAD ANALYTICS (entry point)
    ===================================================== */

    async function loadAnalytics() {

        const container =
            document.getElementById(
                "analytics"
            );


        if (!container) {
            return;
        }


        const { startDate, endDate } =
            getAnalyticsRangeDates();


        if (startDate > endDate) {

            showToast(
                "Start date must be before end date."
            );

            return;

        }


        const sectionFilter =
            document.getElementById(
                "analyticsSectionFilter"
            );


        const sectionFilterId =
            sectionFilter
                ? sectionFilter.value
                : "";


        try {

            const records =
                await loadAnalyticsAttendance(
                    startDate,
                    endDate
                );


            const stats =
                computeAnalytics(
                    records,
                    sectionFilterId
                );


            renderAnalyticsSummary(stats);

            renderTrendChart(stats);

            renderDistributionChart(stats);

            renderSectionChart(stats);


        } catch (error) {

            console.error(
                "Analytics error:",
                error
            );


            showToast(
                "Unable to load analytics data."
            );

        }

    }


    /* =====================================================
       FIND STUDENT
    ===================================================== */

    function getStudent(studentId) {

        return students.find(
            function (student) {

                return (
                    String(student.id) ===
                    String(studentId)
                );

            }
        );

    }


    /* =====================================================
       FIND SECTION
    ===================================================== */

    function getSection(sectionId) {

        return sections.find(
            function (section) {

                return (
                    String(section.id) ===
                    String(sectionId)
                );

            }
        );

    }


    /* =====================================================
       UPDATE DATE
    ===================================================== */

    function updateDate() {

        const selectedDate =
            getSelectedDate();


        const date =
            new Date(
                selectedDate +
                "T12:00:00+08:00"
            );


        const currentDate =
            document.getElementById(
                "currentDate"
            );


        if (currentDate) {

            currentDate.textContent =
                new Intl.DateTimeFormat(
                    "en-PH",
                    {
                        timeZone: "Asia/Manila",
                        dateStyle: "full"
                    }
                ).format(date);

        }

    }


    /* =====================================================
       LAST UPDATED
    ===================================================== */

    function updateLastUpdated() {

        const element =
            document.getElementById(
                "lastUpdated"
            );


        if (!element) {
            return;
        }


        element.textContent =
            "Last updated: " +
            new Intl.DateTimeFormat(
                "en-PH",
                {
                    timeZone: "Asia/Manila",
                    timeStyle: "medium"
                }
            ).format(new Date());

    }


    /* =====================================================
       SECTION FILTERS + EDIT SECTION
    ===================================================== */

    function populateSectionFilters() {

        const filters = [

            document.getElementById(
                "attendanceSectionFilter"
            ),

            document.getElementById(
                "studentSectionFilter"
            ),

            document.getElementById(
                "newStudentSection"
            ),

            document.getElementById(
                "editStudentSection"
            ),

            document.getElementById(
                "analyticsSectionFilter"
            )

        ];


        filters.forEach(
            function (filter) {

                if (!filter) {
                    return;
                }


                const currentValue =
                    filter.value;


                if (
                    filter.id ===
                    "newStudentSection" ||

                    filter.id ===
                    "editStudentSection"
                ) {

                    filter.innerHTML =
                        '<option value="">Select Section</option>';

                } else {

                    filter.innerHTML =
                        '<option value="">All Sections</option>';

                }


                sections.forEach(
                    function (section) {

                        const option =
                            document.createElement(
                                "option"
                            );


                        option.value =
                            section.id;


                        option.textContent =
                            section.section_name;


                        filter.appendChild(
                            option
                        );

                    }
                );


                filter.value =
                    currentValue;

            }
        );

    }


    /* =====================================================
       STATISTICS
       Present / Late come from the real attendance.status
       column (set automatically by the database trigger).
       Absent = active students who have no attendance row
       for the selected school day at all.
    ===================================================== */

    function updateStatistics() {

        const activeStudents =
            students.filter(
                function (student) {

                    return (
                        student.active !== false
                    );

                }
            );


        const total =
            activeStudents.length;


        /* One attendance row per student per school day is
           guaranteed by the unique_student_school_day
           database constraint, so this map is safe. */

        const statusByStudentId = {};


        attendance.forEach(
            function (record) {

                statusByStudentId[
                    String(record.student_id)
                ] = record.status || "Present";

            }
        );


        let present = 0;
        let late = 0;


        activeStudents.forEach(
            function (student) {

                const status =
                    statusByStudentId[
                        String(student.id)
                    ];


                if (status === "Late") {

                    late += 1;

                } else if (status === "Present") {

                    present += 1;

                }

            }
        );


        const absent =
            Math.max(
                total - present - late,
                0
            );


        /* Attendance Rate = (Present + Late) / Total Active x 100
           Both Present and Late students did show up, so both
           count toward the rate. Only true absence counts against it. */

        const rate =
            total > 0
                ? Math.round(
                    ((present + late) / total) * 100
                )
                : 0;


        const totalElement =
            document.getElementById(
                "totalStudents"
            );


        const presentElement =
            document.getElementById(
                "presentStudents"
            );


        const lateElement =
            document.getElementById(
                "lateStudents"
            );


        const absentElement =
            document.getElementById(
                "absentStudents"
            );


        const rateElement =
            document.getElementById(
                "attendanceRate"
            );


        if (totalElement) {
            totalElement.textContent = total;
        }


        if (presentElement) {
            presentElement.textContent = present;
        }


        if (lateElement) {
            lateElement.textContent = late;
        }


        if (absentElement) {
            absentElement.textContent = absent;
        }


        if (rateElement) {
            rateElement.textContent = rate + "%";
        }

    }


    /* =====================================================
       RECENT ATTENDANCE
    ===================================================== */

    function renderRecentAttendance() {

        const container =
            document.getElementById(
                "recentAttendance"
            );


        if (!container) {
            return;
        }


        if (attendance.length === 0) {

            container.innerHTML =
                '<div class="loading">' +
                'No attendance recorded for this date.' +
                '</div>';

            return;

        }


        container.innerHTML =
            attendance
                .slice(0, 10)
                .map(
                    function (record) {

                        const student =
                            getStudent(
                                record.student_id
                            );


                        if (!student) {
                            return "";
                        }


                        const section =
                            getSection(
                                student.section_id
                            );


                        return (

                            '<div class="recent-item">' +

                                '<div>' +

                                    '<div class="recent-name">' +
                                        escapeHTML(
                                            student.name
                                        ) +
                                    '</div>' +

                                    '<div class="recent-time">' +

                                        escapeHTML(
                                            student.student_id ||
                                            "No ID"
                                        ) +

                                        ' • ' +

                                        escapeHTML(
                                            section
                                                ? section.section_name
                                                : "No Section"
                                        ) +

                                    '</div>' +

                                '</div>' +

                                '<div>' +

                                    '<div class="recent-time">' +

                                        formatDateTime(
                                            record.scan_time
                                        ) +

                                    '</div>' +

                                    '<span class="status ' +
                                        statusBadgeClass(record.status) +
                                    '">' +

                                        escapeHTML(
                                            record.status ||
                                            "Present"
                                        ) +

                                    '</span>' +

                                '</div>' +

                            '</div>'

                        );

                    }
                )
                .join("");

    }


    /* =====================================================
       ATTENDANCE TABLE
    ===================================================== */

    function renderAttendanceTable(
        searchTerm
    ) {

        const tbody =
            document.getElementById(
                "attendanceTable"
            );


        if (!tbody) {
            return;
        }


        const sectionFilter =
            document.getElementById(
                "attendanceSectionFilter"
            );


        const selectedSection =
            sectionFilter
                ? sectionFilter.value
                : "";


        const statusFilterEl =
            document.getElementById(
                "attendanceStatusFilter"
            );


        const selectedStatus =
            statusFilterEl
                ? statusFilterEl.value
                : "";


        const search =
            (searchTerm || "")
                .toLowerCase()
                .trim();


        const filtered =
            attendance.filter(
                function (record) {

                    const student =
                        getStudent(
                            record.student_id
                        );


                    if (!student) {
                        return false;
                    }


                    const section =
                        getSection(
                            student.section_id
                        );


                    const text =
                        (
                            student.name +
                            " " +
                            (
                                student.student_id ||
                                ""
                            ) +
                            " " +
                            (
                                section
                                    ? section.section_name
                                    : ""
                            )
                        )
                        .toLowerCase();


                    const matchesSearch =
                        text.includes(search);


                    const matchesSection =
                        !selectedSection ||
                        String(
                            student.section_id
                        ) ===
                        String(
                            selectedSection
                        );


                    const matchesStatus =
                        !selectedStatus ||
                        (record.status || "Present") ===
                        selectedStatus;


                    return (
                        matchesSearch &&
                        matchesSection &&
                        matchesStatus
                    );

                }
            );


        if (filtered.length === 0) {

            tbody.innerHTML =
                '<tr>' +
                '<td colspan="6" class="loading">' +
                'No attendance records found.' +
                '</td>' +
                '</tr>';

            return;

        }


        tbody.innerHTML =
            filtered
                .map(
                    function (record) {

                        const student =
                            getStudent(
                                record.student_id
                            );


                        const section =
                            getSection(
                                student.section_id
                            );


                        return (

                            '<tr>' +

                                '<td>' +

                                    '<button ' +
                                        'type="button" ' +
                                        'class="student-link" ' +
                                        'data-student-id="' +
                                        escapeHTML(
                                            student.id
                                        ) +
                                    '">' +

                                        escapeHTML(
                                            student.name
                                        ) +

                                    '</button>' +

                                '</td>' +

                                '<td>' +

                                    escapeHTML(
                                        student.student_id ||
                                        "—"
                                    ) +

                                '</td>' +

                                '<td>' +

                                    escapeHTML(
                                        section
                                            ? section.section_name
                                            : "—"
                                    ) +

                                '</td>' +

                                '<td>' +

                                    formatDateTime(
                                        record.scan_time
                                    ) +

                                '</td>' +

                                '<td>' +

                                    escapeHTML(
                                        record.scanner_location ||
                                        "—"
                                    ) +

                                '</td>' +

                                '<td>' +

                                    '<span class="status ' +
                                        statusBadgeClass(record.status) +
                                    '">' +

                                        escapeHTML(
                                            record.status ||
                                            "Present"
                                        ) +

                                    '</span>' +

                                '</td>' +

                            '</tr>'

                        );

                    }
                )
                .join("");

    }


    /* =====================================================
       STUDENTS TABLE
    ===================================================== */

    function renderStudents(
        searchTerm
    ) {

        const tbody =
            document.getElementById(
                "studentsTable"
            );


        if (!tbody) {
            return;
        }


        const sectionFilter =
            document.getElementById(
                "studentSectionFilter"
            );


        const selectedSection =
            sectionFilter
                ? sectionFilter.value
                : "";


        const search =
            (searchTerm || "")
                .toLowerCase()
                .trim();


        const filtered =
            students.filter(
                function (student) {

                    const section =
                        getSection(
                            student.section_id
                        );


                    const text =
                        (
                            student.name +
                            " " +
                            (
                                student.student_id ||
                                ""
                            ) +
                            " " +
                            (
                                student.rfid_uid ||
                                ""
                            ) +
                            " " +
                            (
                                section
                                    ? section.section_name
                                    : ""
                            )
                        )
                        .toLowerCase();


                    const matchesSearch =
                        text.includes(search);


                    const matchesSection =
                        !selectedSection ||
                        String(
                            student.section_id
                        ) ===
                        String(
                            selectedSection
                        );


                    return (
                        matchesSearch &&
                        matchesSection
                    );

                }
            );


        if (filtered.length === 0) {

            tbody.innerHTML =
                '<tr>' +
                '<td colspan="7" class="loading">' +
                'No students found.' +
                '</td>' +
                '</tr>';

            return;

        }


        tbody.innerHTML =
            filtered
                .map(
                    function (student) {

                        const section =
                            getSection(
                                student.section_id
                            );


                        const active =
                            student.active !== false;


                        return (

                            '<tr>' +

                                '<td class="avatar-cell">' +

                                    '<img ' +
                                        'class="student-avatar" ' +
                                        'src="' +
                                        escapeHTML(
                                            getStudentPhotoUrl(student)
                                        ) +
                                        '" ' +
                                        'alt="">' +

                                '</td>' +

                                '<td>' +

                                    '<button ' +
                                        'type="button" ' +
                                        'class="student-link" ' +
                                        'data-student-id="' +
                                        escapeHTML(
                                            student.id
                                        ) +
                                    '">' +

                                        escapeHTML(
                                            student.name
                                        ) +

                                    '</button>' +

                                '</td>' +

                                '<td>' +

                                    escapeHTML(
                                        student.student_id ||
                                        "—"
                                    ) +

                                '</td>' +

                                '<td>' +

                                    escapeHTML(
                                        section
                                            ? section.section_name
                                            : "—"
                                    ) +

                                '</td>' +

                                '<td><code>' +

                                    escapeHTML(
                                        student.rfid_uid ||
                                        "—"
                                    ) +

                                '</code></td>' +

                                '<td>' +

                                    '<span class="status ' +

                                        (
                                            active
                                                ? "active"
                                                : "inactive"
                                        ) +

                                    '">' +

                                        (
                                            active
                                                ? "Active"
                                                : "Inactive"
                                        ) +

                                    '</span>' +

                                '</td>' +

                                '<td>' +

                                    '<div class="table-actions">' +

                                        '<button ' +
                                            'type="button" ' +
                                            'class="action-btn edit-student-btn" ' +
                                            'data-student-id="' +
                                            escapeHTML(
                                                student.id
                                            ) +
                                        '">' +

                                            '✏️ Edit' +

                                        '</button>' +

                                        '<button ' +
                                            'type="button" ' +
                                            'class="action-btn delete-student-btn" ' +
                                            'data-student-id="' +
                                            escapeHTML(
                                                student.id
                                            ) +
                                        '">' +

                                            '🗑️ Delete' +

                                        '</button>' +

                                    '</div>' +

                                '</td>' +

                            '</tr>'

                        );

                    }
                )
                .join("");

    }


    /* =====================================================
       SECTIONS
    ===================================================== */

    function renderSections() {

        const container =
            document.getElementById(
                "sectionsGrid"
            );


        if (!container) {
            return;
        }


        if (sections.length === 0) {

            container.innerHTML =
                '<div class="loading">' +
                'No sections found.' +
                '</div>';

            return;

        }


        container.innerHTML =
            sections
                .map(
                    function (section) {

                        const count =
                            students.filter(
                                function (student) {

                                    return (
                                        String(
                                            student.section_id
                                        ) ===
                                        String(
                                            section.id
                                        )
                                    );

                                }
                            ).length;


                        return (

                            '<div class="section-card">' +

                                '<h3>' +

                                    escapeHTML(
                                        section.section_name
                                    ) +

                                '</h3>' +

                                '<p>' +

                                    escapeHTML(
                                        section.grade_level ||
                                        ""
                                    ) +

                                '</p>' +

                                '<div class="section-count">' +

                                    count +

                                '</div>' +

                                '<p>registered student' +

                                    (
                                        count === 1
                                            ? ""
                                            : "s"
                                    ) +

                                '</p>' +

                                '<div class="section-card-actions">' +

                                    '<button ' +
                                        'type="button" ' +
                                        'class="action-btn edit-section-btn" ' +
                                        'data-section-id="' +
                                        escapeHTML(
                                            section.id
                                        ) +
                                    '">' +

                                        '✏️ Edit' +

                                    '</button>' +

                                    '<button ' +
                                        'type="button" ' +
                                        'class="action-btn delete-section-btn" ' +
                                        'data-section-id="' +
                                        escapeHTML(
                                            section.id
                                        ) +
                                    '">' +

                                        '🗑️ Delete' +

                                    '</button>' +

                                '</div>' +

                            '</div>'

                        );

                    }
                )
                .join("");

    }


    /* =====================================================
       TOAST
    ===================================================== */

    function showToast(message) {

        const toast =
            document.getElementById(
                "toast"
            );


        if (!toast) {
            return;
        }


        toast.textContent =
            message;


        toast.classList.add(
            "show"
        );


        setTimeout(
            function () {

                toast.classList.remove(
                    "show"
                );

            },
            3000
        );

    }


    /* =====================================================
       STUDENT PROFILE
    ===================================================== */

    async function openStudentProfile(
        studentId
    ) {

        const student =
            getStudent(studentId);


        if (!student) {

            showToast(
                "Student not found."
            );

            return;

        }


        selectedStudentId =
            student.id;


        const modalPhoto =
            document.getElementById(
                "modalStudentPhoto"
            );


        if (modalPhoto) {

            modalPhoto.src =
                getStudentPhotoUrl(student);

        }


        const section =
            getSection(
                student.section_id
            );


        document.getElementById(
            "modalStudentName"
        ).textContent =
            student.name || "Student Profile";


        document.getElementById(
            "modalStudentInfo"
        ).textContent =
            student.student_id ||
            "No Student ID";


        document.getElementById(
            "modalStudentId"
        ).textContent =
            student.student_id ||
            "—";


        document.getElementById(
            "modalSection"
        ).textContent =
            section
                ? section.section_name
                : "—";


        document.getElementById(
            "modalRFID"
        ).textContent =
            student.rfid_uid ||
            "—";


        document.getElementById(
            "modalStatus"
        ).textContent =
            student.active !== false
                ? "Active"
                : "Inactive";


        const historyContainer =
            document.getElementById(
                "studentHistory"
            );


        if (historyContainer) {

            historyContainer.innerHTML =
                '<div class="loading">' +
                'Loading attendance history...' +
                '</div>';

        }


        const modalOverlay =
            document.getElementById(
                "modalOverlay"
            );


        if (modalOverlay) {

            modalOverlay.classList.add(
                "show"
            );

        }


        try {

            const history =
                await supabaseRequest(
                    "attendance" +
                    "?select=id,student_id,scan_time,scanner_location,status" +
                    "&student_id=eq." +
                    encodeURIComponent(
                        student.id
                    ) +
                    "&order=scan_time.desc"
                );


            const totalAttendance =
                document.getElementById(
                    "modalTotalAttendance"
                );


            const latestScan =
                document.getElementById(
                    "modalLatestScan"
                );


            if (totalAttendance) {

                totalAttendance.textContent =
                    history.length;

            }


            if (latestScan) {

                latestScan.textContent =
                    history.length > 0
                        ? formatDateTime(
                            history[0].scan_time
                        )
                        : "No attendance";

            }


            if (!historyContainer) {
                return;
            }


            if (history.length === 0) {

                historyContainer.innerHTML =
                    '<div class="loading">' +
                    'No attendance records found.' +
                    '</div>';

                return;

            }


            historyContainer.innerHTML =
                history
                    .map(
                        function (record) {

                            return (

                                '<div class="history-item">' +

                                    '<div>' +

                                        '<div class="history-date">' +

                                            formatDateTime(
                                                record.scan_time
                                            ) +

                                        '</div>' +

                                        '<div class="history-time">' +

                                            escapeHTML(
                                                record.scanner_location ||
                                                "No location"
                                            ) +

                                        '</div>' +

                                    '</div>' +

                                    '<span class="status ' +
                                        statusBadgeClass(record.status) +
                                    '">' +

                                        escapeHTML(
                                            record.status ||
                                            "Present"
                                        ) +

                                    '</span>' +

                                '</div>'

                            );

                        }
                    )
                    .join("");

        } catch (error) {

            console.error(
                "Student history error:",
                error
            );


            if (historyContainer) {

                historyContainer.innerHTML =
                    '<div class="loading">' +
                    'Unable to load attendance history.' +
                    '</div>';

            }

        }

    }


    /* =====================================================
       CLOSE STUDENT PROFILE
    ===================================================== */

    function closeStudentModal() {

        const modalOverlay =
            document.getElementById(
                "modalOverlay"
            );


        if (modalOverlay) {

            modalOverlay.classList.remove(
                "show"
            );

        }


        selectedStudentId = null;

    }


    /* =====================================================
       OPEN EDIT MODAL (STUDENT)
    ===================================================== */

    function openEditStudentModal(
        studentId
    ) {

        const student =
            getStudent(studentId);


        if (!student) {

            showToast(
                "Student not found."
            );

            return;

        }


        selectedStudentId =
            student.id;


        const nameInput =
            document.getElementById(
                "editStudentName"
            );


        const idInput =
            document.getElementById(
                "editStudentId"
            );


        const rfidInput =
            document.getElementById(
                "editStudentRFID"
            );


        const sectionInput =
            document.getElementById(
                "editStudentSection"
            );


        if (
            !nameInput ||
            !idInput ||
            !rfidInput ||
            !sectionInput
        ) {

            showToast(
                "Edit form not found."
            );

            return;

        }


        nameInput.value =
            student.name || "";


        idInput.value =
            student.student_id || "";


        rfidInput.value =
            student.rfid_uid || "";


        sectionInput.value =
            student.section_id
                ? String(student.section_id)
                : "";


        /* Reset any pending photo change from a previous
           edit session before showing the current photo. */

        editSelectedPhotoFile = null;
        editRemovePhotoRequested = false;


        const photoPreview =
            document.getElementById(
                "editStudentPhotoPreview"
            );


        const photoInput =
            document.getElementById(
                "editStudentPhotoInput"
            );


        if (photoPreview) {

            photoPreview.src =
                getStudentPhotoUrl(student);

        }


        if (photoInput) {

            photoInput.value = "";

        }


        const editModalOverlay =
            document.getElementById(
                "editModalOverlay"
            );


        if (editModalOverlay) {

            editModalOverlay.classList.add(
                "show"
            );

        }

    }


    /* =====================================================
       CLOSE EDIT MODAL (STUDENT)
    ===================================================== */

    function closeEditStudentModal() {

        const editModalOverlay =
            document.getElementById(
                "editModalOverlay"
            );


        if (editModalOverlay) {

            editModalOverlay.classList.remove(
                "show"
            );

        }

    }


    /* =====================================================
       SAVE EDITED STUDENT
    ===================================================== */

    async function saveStudentEdit() {

        if (!selectedStudentId) {

            showToast(
                "No student selected."
            );

            return;

        }


        const student =
            getStudent(
                selectedStudentId
            );


        if (!student) {

            showToast(
                "Student not found."
            );

            return;

        }


        const nameInput =
            document.getElementById(
                "editStudentName"
            );


        const idInput =
            document.getElementById(
                "editStudentId"
            );


        const rfidInput =
            document.getElementById(
                "editStudentRFID"
            );


        const sectionInput =
            document.getElementById(
                "editStudentSection"
            );


        const newName =
            nameInput.value.trim();


        const newStudentId =
            idInput.value.trim();


        const newRFID =
            normalizeRFID(
                rfidInput.value
            );


        const newSectionId =
            sectionInput.value;


        if (!newName) {

            alert(
                "Student name cannot be empty."
            );

            return;

        }


        if (!newStudentId) {

            alert(
                "Student ID cannot be empty."
            );

            return;

        }


        if (!newRFID) {

            alert(
                "RFID UID cannot be empty."
            );

            return;

        }


        if (!newSectionId) {

            alert(
                "Please select a section."
            );

            return;

        }


        /* =========================================
           CHECK DUPLICATE STUDENT ID
           (Backed by the unique_student_id database
           constraint as the final protection.)
        ========================================= */

        const duplicateStudentId =
            students.find(
                function (item) {

                    return (
                        String(item.id) !==
                        String(selectedStudentId) &&

                        String(
                            item.student_id || ""
                        ).toLowerCase() ===
                        newStudentId.toLowerCase()
                    );

                }
            );


        if (duplicateStudentId) {

            alert(
                "That Student ID is already registered."
            );

            return;

        }


        /* =========================================
           CHECK DUPLICATE RFID
           (Backed by the unique_rfid_uid database
           constraint as the final protection.)
        ========================================= */

        const duplicateRFID =
            students.find(
                function (item) {

                    return (
                        String(item.id) !==
                        String(selectedStudentId) &&

                        normalizeRFID(
                            item.rfid_uid || ""
                        ) === newRFID
                    );

                }
            );


        if (duplicateRFID) {

            alert(
                "That RFID UID is already registered to another student."
            );

            return;

        }


        try {

            showToast(
                "Saving changes..."
            );


            /* =========================================
               HANDLE PHOTO CHANGE (if any)
               Runs before the main PATCH so the new/cleared
               URL can be saved together with the other fields.
            ========================================= */

            let newPhotoUrl =
                student.profile_picture_url || null;


            if (editSelectedPhotoFile) {

                showToast(
                    "Uploading photo..."
                );


                newPhotoUrl =
                    await uploadStudentPhoto(
                        selectedStudentId,
                        editSelectedPhotoFile
                    );


                /* Clean up an old file if a previous upload
                   used a different extension (e.g. replacing
                   a .png with a .jpg leaves the old .png
                   file behind at a different path). */

                const oldPath =
                    extractStoragePath(
                        student.profile_picture_url
                    );


                const newPath =
                    extractStoragePath(
                        newPhotoUrl
                    );


                if (
                    oldPath &&
                    oldPath !== newPath
                ) {

                    await deleteStudentPhoto(
                        oldPath
                    );

                }


            } else if (editRemovePhotoRequested) {

                const oldPath =
                    extractStoragePath(
                        student.profile_picture_url
                    );


                await deleteStudentPhoto(
                    oldPath
                );


                newPhotoUrl = null;

            }


            await supabaseRequest(
                "students?id=eq." +
                encodeURIComponent(
                    selectedStudentId
                ),
                {
                    method: "PATCH",

                    body: {
                        name:
                            newName,

                        student_id:
                            newStudentId,

                        rfid_uid:
                            newRFID,

                        section_id:
                            Number(
                                newSectionId
                            ),

                        profile_picture_url:
                            newPhotoUrl
                    },

                    headers: {
                        "Prefer":
                            "return=minimal"
                    }
                }
            );


            editSelectedPhotoFile = null;

            editRemovePhotoRequested = false;


            closeEditStudentModal();


            await loadDashboard(
                false
            );


            await openStudentProfile(
                selectedStudentId
            );


            showToast(
                "Student information updated successfully."
            );


        } catch (error) {

            console.error(
                "Save student edit error:",
                error
            );


            if (
                error.message &&
                error.message.includes("unique_rfid_uid")
            ) {

                alert(
                    "That RFID UID is already registered to another student."
                );

            } else if (
                error.message &&
                error.message.includes("unique_student_id")
            ) {

                alert(
                    "That Student ID is already registered."
                );

            } else {

                alert(
                    "Unable to update student.\n\n" +
                    error.message
                );

            }

        }

    }


    /* =====================================================
       DELETE STUDENT
    ===================================================== */

    async function deleteStudent(
        studentId = null
    ) {

        const idToDelete =
            studentId ||
            selectedStudentId;


        if (!idToDelete) {

            showToast(
                "No student selected."
            );

            return;

        }


        const student =
            getStudent(
                idToDelete
            );


        if (!student) {

            showToast(
                "Student not found."
            );

            return;

        }


        const confirmed =
            confirm(
                "Are you sure you want to delete " +
                student.name +
                "?\n\n" +
                "This action cannot be undone."
            );


        if (!confirmed) {
            return;
        }


        try {

            showToast(
                "Checking attendance records..."
            );


            /* =========================================
               CHECK ATTENDANCE HISTORY
            ========================================= */

            const studentAttendance =
                await supabaseRequest(
                    "attendance" +
                    "?select=id" +
                    "&student_id=eq." +
                    encodeURIComponent(
                        idToDelete
                    )
                );


            if (
                studentAttendance &&
                studentAttendance.length > 0
            ) {

                alert(
                    "This student cannot be deleted because " +
                    "they already have " +
                    studentAttendance.length +
                    " attendance record(s).\n\n" +
                    "This protects your attendance history."
                );


                showToast(
                    "Student was not deleted."
                );


                return;

            }


            /* =========================================
               DELETE STUDENT
            ========================================= */

            showToast(
                "Deleting student..."
            );


            await supabaseRequest(
                "students?id=eq." +
                encodeURIComponent(
                    idToDelete
                ),
                {
                    method: "DELETE",

                    headers: {
                        "Prefer":
                            "return=minimal"
                    }
                }
            );


            closeStudentModal();


            closeEditStudentModal();


            selectedStudentId =
                null;


            await loadDashboard(
                false
            );


            showToast(
                "Student deleted successfully."
            );


        } catch (error) {

            console.error(
                "Delete student error:",
                error
            );


            alert(
                "Unable to delete student.\n\n" +
                error.message
            );


            showToast(
                "Unable to delete student."
            );

        }

    }


    /* =====================================================
       ADD STUDENT
    ===================================================== */

    async function addStudent() {

        const nameInput =
            document.getElementById(
                "newStudentName"
            );


        const idInput =
            document.getElementById(
                "newStudentId"
            );


        const rfidInput =
            document.getElementById(
                "newStudentRFID"
            );


        const sectionInput =
            document.getElementById(
                "newStudentSection"
            );


        const name =
            nameInput.value.trim();


        const studentId =
            idInput.value.trim();


        const rfid =
            normalizeRFID(
                rfidInput.value
            );


        const sectionId =
            sectionInput.value;


        if (!name) {

            alert(
                "Please enter the student's name."
            );

            return;

        }


        if (!studentId) {

            alert(
                "Please enter the Student ID."
            );

            return;

        }


        if (!rfid) {

            alert(
                "Please enter the RFID UID."
            );

            return;

        }


        if (!sectionId) {

            alert(
                "Please select a section."
            );

            return;

        }


        /* =========================================
           CHECK DUPLICATE STUDENT ID
        ========================================= */

        const duplicateStudentId =
            students.find(
                function (student) {

                    return (
                        String(
                            student.student_id || ""
                        ).toLowerCase() ===
                        studentId.toLowerCase()
                    );

                }
            );


        if (duplicateStudentId) {

            alert(
                "That Student ID is already registered."
            );

            return;

        }


        /* =========================================
           CHECK DUPLICATE RFID
        ========================================= */

        const duplicateRFID =
            students.find(
                function (student) {

                    return (
                        normalizeRFID(
                            student.rfid_uid || ""
                        ) === rfid
                    );

                }
            );


        if (duplicateRFID) {

            alert(
                "That RFID UID is already registered."
            );

            return;

        }


        try {

            showToast(
                "Adding student..."
            );


            await supabaseRequest(
                "students",
                {
                    method: "POST",

                    body: {
                        student_id:
                            studentId,

                        name:
                            name,

                        section_id:
                            Number(sectionId),

                        rfid_uid:
                            rfid,

                        active:
                            true
                    },

                    headers: {
                        "Prefer":
                            "return=minimal"
                    }
                }
            );


            nameInput.value = "";
            idInput.value = "";
            rfidInput.value = "";
            sectionInput.value = "";


            await loadDashboard(
                false
            );


            showToast(
                "Student added successfully."
            );


        } catch (error) {

            console.error(
                "Add student error:",
                error
            );


            if (
                error.message &&
                error.message.includes("unique_rfid_uid")
            ) {

                alert(
                    "That RFID UID is already registered to another student."
                );

            } else if (
                error.message &&
                error.message.includes("unique_student_id")
            ) {

                alert(
                    "That Student ID is already registered."
                );

            } else {

                alert(
                    "Unable to add student.\n\n" +
                    error.message
                );

            }

        }

    }


    /* =====================================================
       ADD SECTION
    ===================================================== */

    async function addSection() {

        const nameInput =
            document.getElementById(
                "newSectionName"
            );


        const gradeInput =
            document.getElementById(
                "newGradeLevel"
            );


        const sectionName =
            nameInput.value.trim();


        const gradeLevel =
            gradeInput.value.trim();


        if (!sectionName) {

            alert(
                "Please enter the section name."
            );

            return;

        }


        if (!gradeLevel) {

            alert(
                "Please enter the grade level."
            );

            return;

        }


        try {

            showToast(
                "Adding section..."
            );


            await supabaseRequest(
                "sections",
                {
                    method: "POST",

                    body: {
                        section_name:
                            sectionName,

                        grade_level:
                            gradeLevel
                    },

                    headers: {
                        "Prefer":
                            "return=minimal"
                    }
                }
            );


            nameInput.value = "";
            gradeInput.value = "";


            await loadDashboard(
                false
            );


            showToast(
                "Section added successfully."
            );


        } catch (error) {

            console.error(
                "Add section error:",
                error
            );


            alert(
                "Unable to add section.\n\n" +
                error.message
            );

        }

    }


    /* =====================================================
       OPEN EDIT MODAL (SECTION)
    ===================================================== */

    function openEditSectionModal(
        sectionId
    ) {

        const section =
            getSection(sectionId);


        if (!section) {

            showToast(
                "Section not found."
            );

            return;

        }


        selectedSectionId =
            section.id;


        const nameInput =
            document.getElementById(
                "editSectionName"
            );


        const gradeInput =
            document.getElementById(
                "editGradeLevel"
            );


        if (
            !nameInput ||
            !gradeInput
        ) {

            showToast(
                "Edit form not found."
            );

            return;

        }


        nameInput.value =
            section.section_name || "";


        gradeInput.value =
            section.grade_level || "";


        const overlay =
            document.getElementById(
                "editSectionModalOverlay"
            );


        if (overlay) {

            overlay.classList.add(
                "show"
            );

        }

    }


    /* =====================================================
       CLOSE EDIT MODAL (SECTION)
    ===================================================== */

    function closeEditSectionModal() {

        const overlay =
            document.getElementById(
                "editSectionModalOverlay"
            );


        if (overlay) {

            overlay.classList.remove(
                "show"
            );

        }


        selectedSectionId = null;

    }


    /* =====================================================
       SAVE EDITED SECTION
    ===================================================== */

    async function saveSectionEdit() {

        if (!selectedSectionId) {

            showToast(
                "No section selected."
            );

            return;

        }


        const nameInput =
            document.getElementById(
                "editSectionName"
            );


        const gradeInput =
            document.getElementById(
                "editGradeLevel"
            );


        const newName =
            nameInput.value.trim();


        const newGrade =
            gradeInput.value.trim();


        if (!newName) {

            alert(
                "Section name cannot be empty."
            );

            return;

        }


        if (!newGrade) {

            alert(
                "Grade level cannot be empty."
            );

            return;

        }


        /* =========================================
           CHECK DUPLICATE SECTION NAME
        ========================================= */

        const duplicate =
            sections.find(
                function (item) {

                    return (
                        String(item.id) !==
                        String(selectedSectionId) &&

                        String(
                            item.section_name || ""
                        ).toLowerCase() ===
                        newName.toLowerCase()
                    );

                }
            );


        if (duplicate) {

            alert(
                "A section with that name already exists."
            );

            return;

        }


        try {

            showToast(
                "Saving changes..."
            );


            await supabaseRequest(
                "sections?id=eq." +
                encodeURIComponent(
                    selectedSectionId
                ),
                {
                    method: "PATCH",

                    body: {
                        section_name:
                            newName,

                        grade_level:
                            newGrade
                    },

                    headers: {
                        "Prefer":
                            "return=minimal"
                    }
                }
            );


            closeEditSectionModal();


            await loadDashboard(
                false
            );


            showToast(
                "Section updated successfully."
            );


        } catch (error) {

            console.error(
                "Save section edit error:",
                error
            );


            alert(
                "Unable to update section.\n\n" +
                error.message
            );

        }

    }


    /* =====================================================
       DELETE SECTION
    ===================================================== */

    async function deleteSection(
        sectionId = null
    ) {

        const idToDelete =
            sectionId ||
            selectedSectionId;


        if (!idToDelete) {

            showToast(
                "No section selected."
            );

            return;

        }


        const section =
            getSection(
                idToDelete
            );


        if (!section) {

            showToast(
                "Section not found."
            );

            return;

        }


        /* =========================================
           CHECK STUDENTS IN SECTION
        ========================================= */

        const studentsInSection =
            students.filter(
                function (student) {

                    return (
                        String(
                            student.section_id
                        ) ===
                        String(idToDelete)
                    );

                }
            );


        if (studentsInSection.length > 0) {

            alert(
                "This section cannot be deleted because it has " +
                studentsInSection.length +
                " student(s) assigned to it.\n\n" +
                "Please reassign or remove those students first."
            );


            return;

        }


        const confirmed =
            confirm(
                "Are you sure you want to delete " +
                section.section_name +
                "?\n\n" +
                "This action cannot be undone."
            );


        if (!confirmed) {
            return;
        }


        try {

            showToast(
                "Deleting section..."
            );


            await supabaseRequest(
                "sections?id=eq." +
                encodeURIComponent(
                    idToDelete
                ),
                {
                    method: "DELETE",

                    headers: {
                        "Prefer":
                            "return=minimal"
                    }
                }
            );


            closeEditSectionModal();


            selectedSectionId =
                null;


            await loadDashboard(
                false
            );


            showToast(
                "Section deleted successfully."
            );


        } catch (error) {

            console.error(
                "Delete section error:",
                error
            );


            alert(
                "Unable to delete section.\n\n" +
                error.message
            );

        }

    }


    /* =====================================================
       CSV EXPORT
    ===================================================== */

    function exportAttendanceCSV() {

        if (attendance.length === 0) {

            alert(
                "There are no attendance records to export."
            );

            return;

        }


        const rows = [];


        rows.push([
            "Student Name",
            "Student ID",
            "Section",
            "Scan Time",
            "Location",
            "Status"
        ]);


        attendance.forEach(
            function (record) {

                const student =
                    getStudent(
                        record.student_id
                    );


                if (!student) {
                    return;
                }


                const section =
                    getSection(
                        student.section_id
                    );


                rows.push([

                    student.name || "",

                    student.student_id || "",

                    section
                        ? section.section_name
                        : "",

                    formatDateTime(
                        record.scan_time
                    ),

                    record.scanner_location ||
                    "",

                    record.status ||
                    "Present"

                ]);

            }
        );


        const csv =
            rows
                .map(
                    function (row) {

                        return row
                            .map(
                                function (value) {

                                    return '"' +
                                        String(value)
                                            .replace(
                                                /"/g,
                                                '""'
                                            ) +
                                        '"';

                                }
                            )
                            .join(",");

                    }
                )
                .join("\n");


        const blob =
            new Blob(
                [csv],
                {
                    type:
                        "text/csv;charset=utf-8;"
                }
            );


        const url =
            URL.createObjectURL(
                blob
            );


        const link =
            document.createElement(
                "a"
            );


        link.href =
            url;


        link.download =
            "attendance_" +
            getSelectedDate() +
            ".csv";


        document.body.appendChild(
            link
        );


        link.click();


        document.body.removeChild(
            link
        );


        URL.revokeObjectURL(
            url
        );


        showToast(
            "CSV exported successfully."
        );

    }


    /* =====================================================
       LOAD DASHBOARD
    ===================================================== */

    async function loadDashboard(
        showMessage
    ) {

        try {

            const sidebarEmail =
                document.getElementById(
                    "sidebarUserEmail"
                );


            if (sidebarEmail && currentSession.email) {

                sidebarEmail.textContent =
                    currentSession.email;

            }


            updateDate();


            await Promise.all([
                loadStudents(),
                loadSections(),
                loadSettings()
            ]);


            populateSectionFilters();


            populateSettingsForm();


            await loadAttendance();


            updateStatistics();


            renderRecentAttendance();


            const attendanceSearch =
                document.getElementById(
                    "attendanceSearch"
                );


            renderAttendanceTable(
                attendanceSearch
                    ? attendanceSearch.value
                    : ""
            );


            const studentSearch =
                document.getElementById(
                    "studentSearch"
                );


            renderStudents(
                studentSearch
                    ? studentSearch.value
                    : ""
            );


            renderSections();


            updateLastUpdated();


            console.log(
                "Dashboard loaded successfully"
            );


            if (showMessage) {

                showToast(
                    "Attendance data refreshed."
                );

            }


        } catch (error) {

            console.error(
                "Dashboard error:",
                error
            );


            showToast(
                "Unable to load Supabase data."
            );

        }

    }


    /* =====================================================
       EVENT LISTENERS
    ===================================================== */

    /* -------------------------------------
       CLOSE PROFILE MODAL
    ------------------------------------- */

    const closeModal =
        document.getElementById(
            "closeModal"
        );


    if (closeModal) {

        closeModal.addEventListener(
            "click",
            closeStudentModal
        );

    }


    /* -------------------------------------
       PROFILE MODAL OVERLAY
       Only close when clicking outside modal
    ------------------------------------- */

    const modalOverlay =
        document.getElementById(
            "modalOverlay"
        );


    if (modalOverlay) {

        modalOverlay.addEventListener(
            "click",
            function (event) {

                if (
                    event.target ===
                    modalOverlay
                ) {

                    closeStudentModal();

                }

            }
        );

    }


    /* -------------------------------------
       CLOSE EDIT MODAL (STUDENT)
    ------------------------------------- */

    const closeEditModal =
        document.getElementById(
            "closeEditModal"
        );


    if (closeEditModal) {

        closeEditModal.addEventListener(
            "click",
            closeEditStudentModal
        );

    }


    /* -------------------------------------
       CANCEL EDIT (STUDENT)
    ------------------------------------- */

    const cancelEditBtn =
        document.getElementById(
            "cancelEditBtn"
        );


    if (cancelEditBtn) {

        cancelEditBtn.addEventListener(
            "click",
            closeEditStudentModal
        );

    }


    /* -------------------------------------
       EDIT MODAL OVERLAY (STUDENT)
    ------------------------------------- */

    const editModalOverlay =
        document.getElementById(
            "editModalOverlay"
        );


    if (editModalOverlay) {

        editModalOverlay.addEventListener(
            "click",
            function (event) {

                if (
                    event.target ===
                    editModalOverlay
                ) {

                    closeEditStudentModal();

                }

            }
        );

    }


    /* -------------------------------------
       SAVE EDIT (STUDENT)
    ------------------------------------- */

    const saveStudentEditBtn =
        document.getElementById(
            "saveStudentEditBtn"
        );


    if (saveStudentEditBtn) {

        saveStudentEditBtn.addEventListener(
            "click",
            saveStudentEdit
        );

    }


    /* -------------------------------------
       STUDENT PHOTO INPUT (choose file)
    ------------------------------------- */

    const editStudentPhotoInput =
        document.getElementById(
            "editStudentPhotoInput"
        );


    if (editStudentPhotoInput) {

        editStudentPhotoInput.addEventListener(
            "change",
            function (event) {

                const file =
                    event.target.files[0];


                if (!file) {
                    return;
                }


                const validationError =
                    validatePhotoFile(file);


                if (validationError) {

                    alert(validationError);

                    event.target.value = "";

                    return;

                }


                editSelectedPhotoFile = file;

                editRemovePhotoRequested = false;


                const preview =
                    document.getElementById(
                        "editStudentPhotoPreview"
                    );


                if (preview) {

                    const reader =
                        new FileReader();


                    reader.onload =
                        function (loadEvent) {

                            preview.src =
                                loadEvent.target.result;

                        };


                    reader.readAsDataURL(file);

                }

            }
        );

    }


    /* -------------------------------------
       REMOVE STUDENT PHOTO
    ------------------------------------- */

    const removeStudentPhotoBtn =
        document.getElementById(
            "removeStudentPhotoBtn"
        );


    if (removeStudentPhotoBtn) {

        removeStudentPhotoBtn.addEventListener(
            "click",
            function () {

                editSelectedPhotoFile = null;

                editRemovePhotoRequested = true;


                const preview =
                    document.getElementById(
                        "editStudentPhotoPreview"
                    );


                if (preview) {

                    preview.src = DEFAULT_AVATAR;

                }


                if (editStudentPhotoInput) {

                    editStudentPhotoInput.value = "";

                }

            }
        );

    }


    /* -------------------------------------
       CLOSE EDIT MODAL (SECTION)
    ------------------------------------- */

    const closeEditSectionModalBtn =
        document.getElementById(
            "closeEditSectionModal"
        );


    if (closeEditSectionModalBtn) {

        closeEditSectionModalBtn.addEventListener(
            "click",
            closeEditSectionModal
        );

    }


    /* -------------------------------------
       CANCEL EDIT (SECTION)
    ------------------------------------- */

    const cancelSectionEditBtn =
        document.getElementById(
            "cancelSectionEditBtn"
        );


    if (cancelSectionEditBtn) {

        cancelSectionEditBtn.addEventListener(
            "click",
            closeEditSectionModal
        );

    }


    /* -------------------------------------
       EDIT MODAL OVERLAY (SECTION)
    ------------------------------------- */

    const editSectionModalOverlay =
        document.getElementById(
            "editSectionModalOverlay"
        );


    if (editSectionModalOverlay) {

        editSectionModalOverlay.addEventListener(
            "click",
            function (event) {

                if (
                    event.target ===
                    editSectionModalOverlay
                ) {

                    closeEditSectionModal();

                }

            }
        );

    }


    /* -------------------------------------
       SAVE EDIT (SECTION)
    ------------------------------------- */

    const saveSectionEditBtn =
        document.getElementById(
            "saveSectionEditBtn"
        );


    if (saveSectionEditBtn) {

        saveSectionEditBtn.addEventListener(
            "click",
            saveSectionEdit
        );

    }


    /* -------------------------------------
       SAVE SETTINGS
    ------------------------------------- */

    const saveSettingsBtn =
        document.getElementById(
            "saveSettingsBtn"
        );


    if (saveSettingsBtn) {

        saveSettingsBtn.addEventListener(
            "click",
            saveSettings
        );

    }


    /* -------------------------------------
       STUDENT PROFILE / TABLE ACTIONS /
       SECTION CARD ACTIONS (delegated)
    ------------------------------------- */

    document.addEventListener(
        "click",
        function (event) {

            /* STUDENT PROFILE */

            const studentLink =
                event.target.closest(
                    ".student-link"
                );


            if (
                studentLink &&
                studentLink.dataset.studentId
            ) {

                openStudentProfile(
                    studentLink.dataset.studentId
                );

                return;

            }


            /* EDIT STUDENT BUTTON */

            const editButton =
                event.target.closest(
                    ".edit-student-btn"
                );


            if (
                editButton &&
                editButton.dataset.studentId
            ) {

                event.stopPropagation();


                openEditStudentModal(
                    editButton.dataset.studentId
                );


                return;

            }


            /* DELETE STUDENT BUTTON */

            const deleteButton =
                event.target.closest(
                    ".delete-student-btn"
                );


            if (
                deleteButton &&
                deleteButton.dataset.studentId
            ) {

                event.stopPropagation();


                deleteStudent(
                    deleteButton.dataset.studentId
                );


                return;

            }


            /* EDIT SECTION BUTTON */

            const editSectionButton =
                event.target.closest(
                    ".edit-section-btn"
                );


            if (
                editSectionButton &&
                editSectionButton.dataset.sectionId
            ) {

                event.stopPropagation();


                openEditSectionModal(
                    editSectionButton.dataset.sectionId
                );


                return;

            }


            /* DELETE SECTION BUTTON */

            const deleteSectionButton =
                event.target.closest(
                    ".delete-section-btn"
                );


            if (
                deleteSectionButton &&
                deleteSectionButton.dataset.sectionId
            ) {

                event.stopPropagation();


                deleteSection(
                    deleteSectionButton.dataset.sectionId
                );


                return;

            }

        }
    );


    /* -------------------------------------
       PROFILE DELETE BUTTON
    ------------------------------------- */

    const deleteStudentBtn =
        document.getElementById(
            "deleteStudentBtn"
        );


    if (deleteStudentBtn) {

        deleteStudentBtn.addEventListener(
            "click",
            function () {

                deleteStudent();

            }
        );

    }


    /* -------------------------------------
       PROFILE EDIT BUTTON
    ------------------------------------- */

    const editStudentBtn =
        document.getElementById(
            "editStudentBtn"
        );


    if (editStudentBtn) {

        editStudentBtn.addEventListener(
            "click",
            function () {

                if (!selectedStudentId) {

                    showToast(
                        "No student selected."
                    );

                    return;

                }


                openEditStudentModal(
                    selectedStudentId
                );

            }
        );

    }


    /* -------------------------------------
       ADD STUDENT
    ------------------------------------- */

    const addStudentBtn =
        document.getElementById(
            "addStudentBtn"
        );


    if (addStudentBtn) {

        addStudentBtn.addEventListener(
            "click",
            addStudent
        );

    }


    /* -------------------------------------
       ADD SECTION
    ------------------------------------- */

    const addSectionBtn =
        document.getElementById(
            "addSectionBtn"
        );


    if (addSectionBtn) {

        addSectionBtn.addEventListener(
            "click",
            addSection
        );

    }


    /* -------------------------------------
       REFRESH
    ------------------------------------- */

    const refreshBtn =
        document.getElementById(
            "refreshBtn"
        );


    if (refreshBtn) {

        refreshBtn.addEventListener(
            "click",
            function () {

                loadDashboard(true);

            }
        );

    }


    /* -------------------------------------
       SIGN OUT
    ------------------------------------- */

    const signOutBtn =
        document.getElementById(
            "signOutBtn"
        );


    if (signOutBtn) {

        signOutBtn.addEventListener(
            "click",
            async function () {

                const confirmed =
                    confirm(
                        "Are you sure you want to sign out?"
                    );


                if (!confirmed) {
                    return;
                }


                try {

                    /* Best-effort: revoke the token on
                       Supabase's side. Even if this fails
                       (network issue, already-expired token),
                       we still clear the local session below
                       so the user is signed out on this device
                       regardless. */

                    await fetch(
                        SUPABASE_URL +
                        "/auth/v1/logout",
                        {
                            method: "POST",

                            headers: {
                                "apikey": SUPABASE_KEY,

                                "Authorization":
                                    "Bearer " +
                                    currentSession.access_token
                            }
                        }
                    );

                } catch (error) {

                    console.error(
                        "Sign out error:",
                        error
                    );

                }


                localStorage.removeItem(
                    SESSION_KEY
                );

                sessionStorage.removeItem(
                    SESSION_KEY
                );


                window.location.href =
                    "login.html";

            }
        );

    }


    /* -------------------------------------
       CSV EXPORT
    ------------------------------------- */

    const exportCsvBtn =
        document.getElementById(
            "exportCsvBtn"
        );


    if (exportCsvBtn) {

        exportCsvBtn.addEventListener(
            "click",
            exportAttendanceCSV
        );

    }


    /* -------------------------------------
       ATTENDANCE SEARCH
    ------------------------------------- */

    const attendanceSearch =
        document.getElementById(
            "attendanceSearch"
        );


    if (attendanceSearch) {

        attendanceSearch.addEventListener(
            "input",
            function (event) {

                renderAttendanceTable(
                    event.target.value
                );

            }
        );

    }


    /* -------------------------------------
       STUDENT SEARCH
    ------------------------------------- */

    const studentSearch =
        document.getElementById(
            "studentSearch"
        );


    if (studentSearch) {

        studentSearch.addEventListener(
            "input",
            function (event) {

                renderStudents(
                    event.target.value
                );

            }
        );

    }


    /* -------------------------------------
       ATTENDANCE SECTION FILTER
    ------------------------------------- */

    const attendanceSectionFilter =
        document.getElementById(
            "attendanceSectionFilter"
        );


    if (attendanceSectionFilter) {

        attendanceSectionFilter.addEventListener(
            "change",
            function () {

                renderAttendanceTable(
                    attendanceSearch
                        ? attendanceSearch.value
                        : ""
                );

            }
        );

    }


    /* -------------------------------------
       ATTENDANCE STATUS FILTER
    ------------------------------------- */

    const attendanceStatusFilter =
        document.getElementById(
            "attendanceStatusFilter"
        );


    if (attendanceStatusFilter) {

        attendanceStatusFilter.addEventListener(
            "change",
            function () {

                renderAttendanceTable(
                    attendanceSearch
                        ? attendanceSearch.value
                        : ""
                );

            }
        );

    }


    /* -------------------------------------
       STUDENT SECTION FILTER
    ------------------------------------- */

    const studentSectionFilter =
        document.getElementById(
            "studentSectionFilter"
        );


    if (studentSectionFilter) {

        studentSectionFilter.addEventListener(
            "change",
            function () {

                renderStudents(
                    studentSearch
                        ? studentSearch.value
                        : ""
                );

            }
        );

    }


    /* -------------------------------------
       DATE FILTER
    ------------------------------------- */

    const dateFilter =
        document.getElementById(
            "dateFilter"
        );


    if (dateFilter) {

        dateFilter.value =
            getManilaDate();


        dateFilter.addEventListener(
            "change",
            function () {

                loadDashboard(true);

            }
        );

    }


    /* -------------------------------------
       ANALYTICS FILTERS
    ------------------------------------- */

    const analyticsRange =
        document.getElementById(
            "analyticsRange"
        );


    if (analyticsRange) {

        toggleCustomDateInputs();


        analyticsRange.addEventListener(
            "change",
            function () {

                toggleCustomDateInputs();

                loadAnalytics();

            }
        );

    }


    const analyticsStartDate =
        document.getElementById(
            "analyticsStartDate"
        );


    const analyticsEndDate =
        document.getElementById(
            "analyticsEndDate"
        );


    [analyticsStartDate, analyticsEndDate].forEach(
        function (input) {

            if (input) {

                input.addEventListener(
                    "change",
                    loadAnalytics
                );

            }

        }
    );


    const analyticsSectionFilter =
        document.getElementById(
            "analyticsSectionFilter"
        );


    if (analyticsSectionFilter) {

        analyticsSectionFilter.addEventListener(
            "change",
            loadAnalytics
        );

    }


    /* -------------------------------------
       TABS
    ------------------------------------- */

    document
        .querySelectorAll(".tab-btn")
        .forEach(
            function (button) {

                button.addEventListener(
                    "click",
                    function () {

                        document
                            .querySelectorAll(
                                ".tab-btn"
                            )
                            .forEach(
                                function (tab) {

                                    tab.classList.remove(
                                        "active"
                                    );

                                }
                            );


                        document
                            .querySelectorAll(
                                ".tab-content"
                            )
                            .forEach(
                                function (content) {

                                    content.classList.remove(
                                        "active"
                                    );

                                }
                            );


                        button.classList.add(
                            "active"
                        );


                        const target =
                            document.getElementById(
                                button.dataset.tab
                            );


                        if (target) {

                            target.classList.add(
                                "active"
                            );

                        }


                        if (
                            button.dataset.tab === "analytics"
                        ) {

                            loadAnalytics();

                        }

                    }
                );

            }
        );


    /* =====================================================
       ESC KEY
    ===================================================== */

    document.addEventListener(
        "keydown",
        function (event) {

            if (
                event.key === "Escape"
            ) {

                closeStudentModal();

                closeEditStudentModal();

                closeEditSectionModal();

            }

        }
    );


    /* =====================================================
       AUTO REFRESH
    ===================================================== */

    setInterval(
        function () {

            loadDashboard(false);

        },
        30000
    );


    /* =====================================================
       START DASHBOARD
    ===================================================== */

    loadDashboard(false);

});
