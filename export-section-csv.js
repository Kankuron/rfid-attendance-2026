/* =====================================================
   EXPORT SECTION CSV  (stand-alone add-on file)
   Adds an "Export by Section" button next to Refresh.
   Exports attendance for one section (or all sections)
   over a date range, with Time In and Time Out.

   - Does NOT modify app.js. app.js stays exactly as it is.
   - Needs the time_out column (run time_out_migration.sql once).
   - Reads the login session that app.js already stores.
     It never refreshes the token itself, because refreshing
     here could invalidate app.js's own session.

   INSTALL: add this line in index.html, right AFTER
            <script src="app.js"></script>
            <script src="export-section-csv.js"></script>
===================================================== */

(function () {

    "use strict";

    /* ---------- CONFIG (same values as app.js) ---------- */

    const SUPABASE_URL = "https://zepbgjlliklvwyipahin.supabase.co";
    const SUPABASE_API = SUPABASE_URL + "/rest/v1";
    const SUPABASE_KEY = "sb_publishable_HJYQXc8ZnQMJBhxHzxAp6Q_dMtY1NwW";
    const SESSION_KEY = "attendance_admin_session";
    const PAGE_SIZE = 1000;


    /* ---------- SESSION ---------- */

    function readSession() {
        try {
            const raw =
                localStorage.getItem(SESSION_KEY) ||
                sessionStorage.getItem(SESSION_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (error) {
            return null;
        }
    }

    function getAccessToken() {
        const session = readSession();
        if (
            !session ||
            !session.access_token ||
            !session.expires_at ||
            session.expires_at <= Date.now()
        ) {
            throw new Error(
                "Your session has expired. Please refresh the page and try again."
            );
        }
        return session.access_token;
    }


    /* ---------- API ---------- */

    async function apiGet(endpoint) {
        const response = await fetch(SUPABASE_API + "/" + endpoint, {
            headers: {
                "apikey": SUPABASE_KEY,
                "Authorization": "Bearer " + getAccessToken()
            }
        });
        if (!response.ok) {
            const text = await response.text();
            throw new Error("Supabase error " + response.status + ": " + text);
        }
        return response.json();
    }

    async function fetchSections() {
        return apiGet("sections?select=id,section_name&order=section_name.asc");
    }

    // Loads every matching row, 1000 at a time, so nothing is cut off.
    async function fetchAttendance(sectionId, fromDate, toDate) {

        const start = new Date(fromDate + "T00:00:00+08:00").toISOString();
        const end = new Date(
            new Date(toDate + "T00:00:00+08:00").getTime() + 24 * 60 * 60 * 1000
        ).toISOString();

        const select =
            "scan_time,time_out,status,scanner_location," +
            "students!inner(student_id,name,section_id,sections(section_name))";

        let url =
            "attendance?select=" + encodeURIComponent(select) +
            "&scan_time=gte." + encodeURIComponent(start) +
            "&scan_time=lt." + encodeURIComponent(end) +
            "&order=scan_time.asc,id.asc";

        if (sectionId) {
            url += "&students.section_id=eq." + encodeURIComponent(sectionId);
        }

        const rows = [];
        for (let offset = 0; ; offset += PAGE_SIZE) {
            const page =
                (await apiGet(url + "&limit=" + PAGE_SIZE + "&offset=" + offset)) || [];
            rows.push(...page);
            if (page.length < PAGE_SIZE) {
                break;
            }
        }
        return rows;
    }


    /* ---------- CSV ---------- */

    // Quote a value and stop spreadsheet formula injection (= + - @).
    function csvCell(value) {
        let text = value === null || value === undefined ? "" : String(value);
        if (/^[=+\-@\t\r]/.test(text)) {
            text = "'" + text;
        }
        return '"' + text.replace(/"/g, '""') + '"';
    }

    function manilaDate(iso) {
        return iso
            ? new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Manila" })
            : "";
    }

    function manilaTime(iso) {
        return iso
            ? new Intl.DateTimeFormat("en-PH", {
                timeZone: "Asia/Manila",
                hour: "2-digit",
                minute: "2-digit",
                hour12: true
            }).format(new Date(iso))
            : "";
    }

    function buildCsv(rows) {

        const items = rows.map(function (r) {
            const student = r.students || {};
            const section =
                (student.sections && student.sections.section_name) || "";
            return {
                date: manilaDate(r.scan_time),
                section: section,
                name: student.name || "",
                cells: [
                    manilaDate(r.scan_time),
                    student.name,
                    student.student_id,
                    section,
                    manilaTime(r.scan_time),
                    manilaTime(r.time_out),      // blank until a time-out exists
                    r.status || "Present",
                    r.scanner_location
                ]
            };
        });

        items.sort(function (a, b) {
            return (
                a.date.localeCompare(b.date) ||
                a.section.localeCompare(b.section) ||
                a.name.localeCompare(b.name)
            );
        });

        const lines = [[
            "Date", "Student Name", "Student ID", "Section",
            "Time In", "Time Out", "Status", "Location"
        ].map(csvCell).join(",")];

        items.forEach(function (item) {
            lines.push(item.cells.map(csvCell).join(","));
        });

        // \uFEFF lets Excel read special characters correctly
        return "\uFEFF" + lines.join("\r\n");
    }

    function downloadCsv(filename, csv) {
        const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }


    /* ---------- UI ---------- */

    function todayManila() {
        return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
    }

    function showToast(message) {
        const toast = document.getElementById("toast");
        if (!toast) { return; }
        toast.textContent = message;
        toast.classList.add("show");
        setTimeout(function () { toast.classList.remove("show"); }, 3000);
    }

    function addStyles() {
        const style = document.createElement("style");
        style.textContent =
            ".esc-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);" +
            "display:flex;align-items:center;justify-content:center;z-index:9999;padding:16px}" +
            ".esc-modal{background:#fff;color:#1f2937;border-radius:16px;padding:24px;" +
            "width:min(100%,420px);box-shadow:0 10px 30px rgba(0,0,0,.25);font-family:inherit}" +
            ".esc-modal h3{margin:0 0 16px;font-size:18px}" +
            ".esc-field{display:flex;flex-direction:column;gap:6px;margin-bottom:12px}" +
            ".esc-field label{font-size:13px;font-weight:600}" +
            ".esc-field select,.esc-field input{height:42px;border:1px solid #d1d5db;" +
            "border-radius:8px;padding:0 10px;font-size:15px;background:#fff;color:#1f2937}" +
            ".esc-row{display:flex;gap:12px}.esc-row .esc-field{flex:1;min-width:0}" +
            ".esc-error{color:#b91c1c;font-size:13px;min-height:18px;margin:4px 0 8px}" +
            ".esc-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:8px}";
        document.head.appendChild(style);
    }

    function field(labelText, control, id) {
        const wrap = document.createElement("div");
        wrap.className = "esc-field";
        const label = document.createElement("label");
        label.htmlFor = id;
        label.textContent = labelText;
        control.id = id;
        wrap.appendChild(label);
        wrap.appendChild(control);
        return wrap;
    }

    function openExportDialog() {

        const overlay = document.createElement("div");
        overlay.className = "esc-overlay";

        const modal = document.createElement("div");
        modal.className = "esc-modal";
        modal.setAttribute("role", "dialog");
        modal.setAttribute("aria-modal", "true");
        modal.setAttribute("aria-label", "Export attendance by section");

        const title = document.createElement("h3");
        title.textContent = "Export Attendance (CSV)";

        const sectionSelect = document.createElement("select");
        const loadingOption = document.createElement("option");
        loadingOption.value = "";
        loadingOption.textContent = "Loading sections...";
        sectionSelect.appendChild(loadingOption);

        const fromInput = document.createElement("input");
        fromInput.type = "date";
        fromInput.value = todayManila();

        const toInput = document.createElement("input");
        toInput.type = "date";
        toInput.value = todayManila();

        const errorBox = document.createElement("div");
        errorBox.className = "esc-error";
        errorBox.setAttribute("role", "alert");

        const cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "btn secondary-btn";
        cancelBtn.textContent = "Cancel";

        const exportBtn = document.createElement("button");
        exportBtn.type = "button";
        exportBtn.className = "btn primary-btn";
        exportBtn.textContent = "Export";

        const actions = document.createElement("div");
        actions.className = "esc-actions";
        actions.appendChild(cancelBtn);
        actions.appendChild(exportBtn);

        const dates = document.createElement("div");
        dates.className = "esc-row";
        dates.appendChild(field("From", fromInput, "escFrom"));
        dates.appendChild(field("To", toInput, "escTo"));

        modal.appendChild(title);
        modal.appendChild(field("Section", sectionSelect, "escSection"));
        modal.appendChild(dates);
        modal.appendChild(errorBox);
        modal.appendChild(actions);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        function close() {
            document.removeEventListener("keydown", onKey);
            overlay.remove();
        }

        function onKey(event) {
            if (event.key === "Escape") { close(); }
        }

        document.addEventListener("keydown", onKey);
        cancelBtn.addEventListener("click", close);
        overlay.addEventListener("click", function (event) {
            if (event.target === overlay) { close(); }
        });


        // Fill the section list
        fetchSections().then(function (sections) {
            sectionSelect.innerHTML = "";
            const all = document.createElement("option");
            all.value = "";
            all.textContent = "All Sections";
            sectionSelect.appendChild(all);
            sections.forEach(function (s) {
                const opt = document.createElement("option");
                opt.value = s.id;
                opt.textContent = s.section_name;
                sectionSelect.appendChild(opt);
            });
        }).catch(function (error) {
            console.error("Export: unable to load sections", error);
            loadingOption.textContent = "Unable to load sections";
            errorBox.textContent = error.message.indexOf("session") !== -1
                ? error.message
                : "Unable to load sections. Please try again.";
        });


        exportBtn.addEventListener("click", async function () {

            errorBox.textContent = "";

            const fromDate = fromInput.value;
            const toDate = toInput.value;

            if (!fromDate || !toDate) {
                errorBox.textContent = "Please choose a start and end date.";
                return;
            }
            if (fromDate > toDate) {
                errorBox.textContent = "The start date must not be after the end date.";
                return;
            }

            exportBtn.disabled = true;
            cancelBtn.disabled = true;
            exportBtn.textContent = "Exporting...";

            try {

                const rows = await fetchAttendance(
                    sectionSelect.value,
                    fromDate,
                    toDate
                );

                if (rows.length === 0) {
                    errorBox.textContent =
                        "No attendance records for that section and date range.";
                    return;
                }

                const selected = sectionSelect.options[sectionSelect.selectedIndex];
                const sectionPart = sectionSelect.value
                    ? selected.textContent.replace(/[^a-z0-9]+/gi, "_")
                    : "all_sections";

                downloadCsv(
                    "attendance_" + sectionPart + "_" + fromDate +
                    (fromDate === toDate ? "" : "_to_" + toDate) + ".csv",
                    buildCsv(rows)
                );

                showToast("Exported " + rows.length + " records.");
                close();

            } catch (error) {

                console.error("Export CSV error:", error);

                if (String(error.message).indexOf("time_out") !== -1) {
                    errorBox.textContent =
                        "The time_out column is missing. Run time_out_migration.sql in Supabase first.";
                } else if (String(error.message).indexOf("session") !== -1) {
                    errorBox.textContent = error.message;
                } else {
                    errorBox.textContent = "Unable to export. Please try again.";
                }

            } finally {

                exportBtn.disabled = false;
                cancelBtn.disabled = false;
                exportBtn.textContent = "Export";

            }
        });

        sectionSelect.focus();
    }

    function init() {

        // Avoid adding the button twice if the file is loaded twice
        if (document.getElementById("exportSectionBtn")) { return; }

        const actions = document.querySelector(".topbar-actions");
        if (!actions) { return; }

        addStyles();

        const button = document.createElement("button");
        button.type = "button";
        button.id = "exportSectionBtn";
        button.className = "btn secondary-btn";
        button.textContent = "Export by Section";
        button.addEventListener("click", openExportDialog);

        const refreshBtn = document.getElementById("refreshBtn");
        actions.insertBefore(button, refreshBtn || null);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }

    // Exposed only so the CSV builder can be tested; nothing else is global.
    window.SectionCsvExport = { buildCsv: buildCsv };

})();
