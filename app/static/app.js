/* Report Agent · 프레임워크 없이 기존 FastAPI에 연결하는 바닐라 JavaScript입니다. */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const API = "/api/v1";
  const PAGE_SIZE = 8;
  // 서버의 6종 보고서 계약에 맞춘 입력 항목입니다. 실제 보고서는 API에서 읽습니다.
  const CATEGORIES = {
    EXPERIMENT: { label: "실험 보고서", fields: [
      ["experiment_date", "실험일", "date"], ["hypothesis", "가설", "textarea"],
      ["result_summary", "실험 결과", "textarea"],
    ] },
    DAILY_WORK: { label: "일일 업무", fields: [
      ["work_date", "업무일", "date"], ["progress", "진행 내용", "textarea"],
      ["blockers", "어려웠던 점", "textarea", true],
    ] },
    RESEARCH_PLAN: { label: "연구 계획", fields: [
      ["research_goal", "연구 목표", "textarea"], ["methodology", "연구 방법", "textarea"],
      ["target_date", "목표일", "date"],
    ] },
    DATA_PROCESSING: { label: "데이터 처리", fields: [
      ["dataset_name", "데이터셋 이름", "text"], ["processing_steps", "처리 과정", "textarea"],
      ["quality_notes", "품질 확인 사항", "textarea", true],
    ] },
    PROMPT: { label: "프롬프트", fields: [["purpose", "사용 목적", "textarea"]] },
    MEETING: { label: "회의록", fields: [
      ["meeting_at", "회의 일시 (한국 시간)", "datetime-local"], ["attendees", "참석자", "text"],
      ["decisions", "결정 사항", "textarea"],
    ] },
  };
  const FIELD_LABELS = {
    title: "제목", author: "작성자", content: "본문", overview: "개요",
    category_code: "보고서 종류", query: "검색어", details: "상세 항목",
    ...Object.fromEntries(Object.values(CATEGORIES).flatMap((c) => c.fields.map(([name, label]) => [name, label]))),
  };
  const state = {
    items: [], total: 0, offset: 0, mode: "title", query: "",
    selected: null, selectedId: null, listBusy: false, summaryBusy: false,
    listSequence: 0, detailSequence: 0, summarySequence: 0,
    listController: null, detailController: null, summaryController: null,
    editor: null, saving: false, deleting: false, deleteTarget: null,
  };
  let messageTimer;

  // 서버에서 온 문자열은 HTML로 실행하지 않고 textContent로 표시합니다.
  function textElement(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = text == null ? "" : String(text);
    return node;
  }
  function showMessage(id, message) {
    $(id).textContent = message || "";
    $(id).hidden = !message;
  }
  function announce(message, tone = "success") {
    clearTimeout(messageTimer);
    $("global-message").classList.toggle("is-error", tone === "error");
    showMessage("global-message", message);
    messageTimer = setTimeout(() => showMessage("global-message", ""), 8000);
  }
  function categoryLabel(code) { return CATEGORIES[code]?.label || code || "보고서"; }

  function errorMessage(data, status) {
    if (data?.error?.message) return data.error.message;
    if (Array.isArray(data?.detail)) {
      const labels = [...new Set(data.detail.map((error) => FIELD_LABELS[error.loc?.at(-1)] || "입력값"))];
      return `${labels.join(", ")}의 값과 길이를 확인해 주세요.`;
    }
    if (typeof data?.detail === "string" && status < 500) return data.detail;
    if (status === 404) return "보고서를 찾을 수 없습니다. 목록을 새로 불러와 주세요.";
    if (status === 409) return "보고서가 변경되었습니다. 입력 내용을 확인한 뒤 다시 조회해 주세요.";
    if (status === 422) return "입력 항목과 필수 값을 확인해 주세요.";
    if (status === 504) return "처리 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.";
    if (status >= 500) return "서버에서 처리하지 못했습니다. 실행 중인 서버와 연결 설정을 확인해 주세요.";
    return `요청을 완료하지 못했습니다. (HTTP ${status})`;
  }

  // fetch()는 HTTP 오류에서 자동으로 예외를 던지지 않으므로 response.ok를 확인합니다.
  async function api(path, { method = "GET", body, signal } = {}) {
    let response;
    try {
      response = await fetch(path, {
        method, signal, credentials: "same-origin", cache: "no-store",
        headers: { Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      if (error.name === "AbortError") throw error;
      throw new Error("서버에 연결할 수 없습니다. 서버 실행 상태를 확인한 뒤 다시 시도해 주세요.");
    }
    if (response.status === 204) return null; // 삭제 성공에는 JSON 본문이 없습니다.
    let data = null;
    if ((response.headers.get("content-type") || "").includes("json")) {
      try { data = await response.json(); } catch { /* 아래에서 형식 오류를 처리합니다. */ }
    }
    if (!response.ok) {
      const error = new Error(errorMessage(data, response.status));
      error.status = response.status;
      error.code = data?.error?.code;
      throw error;
    }
    if (data === null) throw new Error("서버 응답 형식을 확인할 수 없습니다. 페이지를 다시 열어 주세요.");
    return data;
  }

  function koreanParts(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    return Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(date).map((part) => [part.type, part.value]));
  }
  function toMeetingInput(value) {
    const p = koreanParts(value);
    return p ? `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}` : "";
  }
  function todayInKorea() { return toMeetingInput(new Date()).slice(0, 10); }
  function formatDateTime(value) {
    const p = koreanParts(value);
    return p ? `${p.year}.${p.month}.${p.day} ${p.hour}:${p.minute} (한국 시간)` : "—";
  }

  async function checkHealth() {
    $("health-button").disabled = true;
    $("health-label").textContent = "DB 연결 확인 중";
    $("health-button").dataset.status = "checking";
    try {
      const result = await api("/health");
      if (result.status !== "ok") throw new Error("데이터베이스 연결을 확인해 주세요.");
      $("health-label").textContent = "DB 연결됨";
      $("health-button").dataset.status = "ready";
      $("health-button").title = "DB와 검색 확장 연결을 확인했습니다. 클릭하면 다시 확인합니다.";
    } catch (error) {
      $("health-label").textContent = "DB 연결 확인 필요";
      $("health-button").dataset.status = "error";
      $("health-button").title = `${error.message} 클릭하면 다시 확인합니다.`;
    } finally { $("health-button").disabled = false; }
  }
  async function loadCategories() {
    try {
      const data = await api(`${API}/categories`);
      for (const category of data.items || []) {
        if (CATEGORIES[category.code] && category.name) CATEGORIES[category.code].label = category.name;
      }
      populateCategories();
      renderList();
      if (state.selected) $("report-category").textContent = categoryLabel(state.selected.category_code);
    } catch { /* 종류 이름의 기본값은 고정된 API 계약이며, 연결 오류는 목록에서 표시합니다. */ }
  }
  function populateCategories() {
    const previous = $("field-category").value;
    $("field-category").replaceChildren(...Object.entries(CATEGORIES).map(([code, category]) => {
      const option = textElement("option", "", category.label);
      option.value = code;
      return option;
    }));
    $("field-category").value = previous in CATEGORIES ? previous : "DAILY_WORK";
  }
  function updatePagination() {
    const paginated = state.mode === "title";
    $("previous-page").disabled = state.listBusy || !paginated || state.offset === 0;
    $("next-page").disabled = state.listBusy || !paginated || state.offset + PAGE_SIZE >= state.total;
    $("page-label").textContent = state.total ? (paginated
      ? `${Math.floor(state.offset / PAGE_SIZE) + 1} / ${Math.ceil(state.total / PAGE_SIZE)} 페이지`
      : "추천 결과 1건") : "0건";
  }
  function renderList() {
    $("report-list").replaceChildren();
    for (const report of state.items) {
      const card = textElement("button", "report-card", "");
      card.type = "button";
      card.dataset.reportId = String(report.report_id);
      card.classList.toggle("is-selected", report.report_id === state.selectedId);
      card.setAttribute("aria-current", String(report.report_id === state.selectedId));
      card.setAttribute("aria-label", `${report.title}, ${categoryLabel(report.category_code)} 상세 보기`);
      const top = textElement("span", "report-card-top", "");
      top.append(textElement("span", "category-chip", categoryLabel(report.category_code)), textElement("span", "report-card-id", `#${report.report_id}`));
      card.append(top, textElement("span", "report-card-title", report.title));
      if (report.overview) card.append(textElement("span", "report-card-overview", report.overview));
      if (state.mode === "similar") {
        const score = Number.isFinite(report.cosine_similarity) ? ` · 유사도 ${report.cosine_similarity.toFixed(3)}` : "";
        card.append(textElement("span", "report-card-meta", `${report.keyword_match ? "검색어 일치" : "의미 기반 추천"}${score}`));
      } else card.append(textElement("span", "report-card-meta", `수정 버전 ${report.revision}`));
      card.addEventListener("click", () => selectReport(report.report_id, { focus: true }));
      $("report-list").append(card);
    }
    updatePagination();
  }
  function resetSummary() {
    state.summarySequence += 1;
    state.summaryController?.abort();
    state.summaryBusy = false;
    $("summary-button").disabled = false;
    $("summary-button").classList.remove("is-loading");
    $("summary-output").textContent = "";
    $("summary-output").hidden = true;
    $("summary-output").setAttribute("aria-busy", "false");
    $("summary-status").textContent = "버튼을 누르면 선택한 보고서를 최대 3문장으로 요약합니다.";
    showMessage("summary-error", "");
  }
  function detailMessage(message) {
    $("detail-panel").hidden = true;
    $("detail-empty").hidden = false;
    const target = $("detail-empty").querySelector("[data-empty-message]");
    target.textContent = message;
  }
  function clearDetail(message = "목록에서 보고서를 선택해 주세요.") {
    state.detailSequence += 1;
    state.detailController?.abort();
    state.selected = null;
    state.selectedId = null;
    resetSummary();
    detailMessage(message);
  }

  // 요청 순서를 기록하여 늦게 도착한 이전 응답이 새 화면을 덮지 않도록 합니다.
  async function loadReports({ mode = state.mode, query = state.query, offset = 0, preserveSelection = false, selectId = null } = {}) {
    state.listController?.abort();
    state.listController = new AbortController();
    const sequence = ++state.listSequence;
    Object.assign(state, { mode, query, offset, items: [], total: 0, listBusy: true });
    if (!preserveSelection) clearDetail();
    showMessage("list-message", "");
    $("list-empty").hidden = true;
    $("report-list").setAttribute("aria-busy", "true");
    $("search-submit").disabled = true;
    $("report-count").textContent = "…";
    $("list-heading").textContent = mode === "similar" ? "관련 보고서" : (query ? "제목 검색 결과" : "전체 보고서");
    $("list-description").textContent = mode === "similar" ? "관련 보고서를 찾고 있습니다." : "보고서를 불러오고 있습니다.";
    renderList();
    try {
      let data;
      if (mode === "similar") {
        data = await api(`${API}/search/similar`, {
          method: "POST", body: { query, keyword_limit: 20, semantic_limit: 20 }, signal: state.listController.signal,
        });
        if (sequence !== state.listSequence) return false;
        if (!["found", "not_found"].includes(data.status)) throw new Error("검색 결과 형식을 확인해 주세요.");
        state.items = data.status === "found" && data.best_match ? [data.best_match] : [];
        state.total = state.items.length;
        $("list-description").textContent = "검색어 일치와 의미를 바탕으로 관련 보고서 1건을 추천합니다.";
      } else {
        const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
        if (query) params.set("title", query);
        data = await api(`${API}/reports?${params}`, { signal: state.listController.signal });
        if (sequence !== state.listSequence) return false;
        if (!Array.isArray(data.items) || !Number.isFinite(data.total)) throw new Error("목록 응답 형식을 확인해 주세요.");
        state.items = data.items;
        state.total = data.total;
        $("list-description").textContent = query ? `“${query}”이(가) 제목에 포함된 보고서입니다.` : "최근 수정한 보고서부터 보여드립니다.";
      }
      $("report-count").textContent = `${state.total}건`;
      $("list-empty").hidden = state.items.length > 0;
      if (!state.items.length) $("list-empty").textContent = state.mode === "similar"
        ? "관련 보고서가 없습니다. 다른 검색어로 찾아보세요."
        : "표시할 보고서가 없습니다. 검색어를 바꾸거나 새 보고서를 등록해 보세요.";
      renderList();
      if (selectId !== null) await selectReport(selectId, { focus: true });
      else if (state.items.length && (!preserveSelection || !state.selected)) await selectReport(state.items[0].report_id);
      return true;
    } catch (error) {
      if (error.name === "AbortError" || sequence !== state.listSequence) return false;
      showMessage("list-message", error.message);
      $("list-description").textContent = "목록을 불러오지 못했습니다. 전체 보기로 다시 시도할 수 있습니다.";
      $("report-count").textContent = "—";
      return false;
    } finally {
      if (sequence === state.listSequence) {
        state.listBusy = false;
        $("search-submit").disabled = false;
        $("report-list").setAttribute("aria-busy", "false");
        updatePagination();
      }
    }
  }
  function renderDetail(report) {
    $("detail-empty").hidden = true;
    $("detail-panel").hidden = false;
    $("report-category").textContent = categoryLabel(report.category_code);
    $("report-id").textContent = `#${report.report_id}`;
    $("report-title").textContent = report.title;
    $("report-author").textContent = report.author;
    $("report-updated").textContent = formatDateTime(report.updated_at);
    $("report-updated").dateTime = report.updated_at;
    $("report-overview").textContent = report.overview;
    $("report-content").textContent = report.content;
    $("report-details").replaceChildren();
    for (const [name, label, type] of CATEGORIES[report.category_code]?.fields || []) {
      const value = report.details?.[name];
      const wrapper = textElement("div", "detail-field", "");
      wrapper.append(textElement("dt", "", label), textElement("dd", "", value
        ? (type === "datetime-local" ? formatDateTime(value) : value) : "입력하지 않음"));
      $("report-details").append(wrapper);
    }
    if (report.category_code === "PROMPT" && report.details?.active_version_no) {
      const wrapper = textElement("div", "detail-field", "");
      wrapper.append(textElement("dt", "", "사용 중인 프롬프트 버전"), textElement("dd", "", report.details.active_version_no));
      $("report-details").append(wrapper);
    }
  }
  async function selectReport(id, { focus = false } = {}) {
    state.detailController?.abort();
    state.detailController = new AbortController();
    const sequence = ++state.detailSequence;
    state.selected = null;
    state.selectedId = Number(id);
    resetSummary();
    detailMessage("보고서 내용을 불러오고 있습니다.");
    renderList();
    try {
      const report = await api(`${API}/reports/${id}`, { signal: state.detailController.signal });
      if (sequence !== state.detailSequence) return;
      state.selected = report;
      renderDetail(report);
      if (focus) {
        $("report-title").focus({ preventScroll: true });
        if (window.matchMedia("(max-width: 680px)").matches) $("detail-panel").scrollIntoView({ behavior: "auto", block: "start" });
      }
    } catch (error) {
      if (error.name === "AbortError" || sequence !== state.detailSequence) return;
      detailMessage(error.message);
    }
  }
  async function summarizeReport() {
    const report = state.selected;
    if (!report || state.summaryBusy) return;
    resetSummary();
    const sequence = ++state.summarySequence;
    state.summaryController = new AbortController();
    state.summaryBusy = true;
    $("summary-button").disabled = true;
    $("summary-button").classList.add("is-loading");
    $("summary-status").textContent = "보고서를 읽고 요약하고 있습니다. 잠시 기다려 주세요.";
    $("summary-output").setAttribute("aria-busy", "true");
    try {
      const result = await api(`${API}/reports/${report.report_id}/summarize`, {
        method: "POST", body: { style: "brief", max_sentences: 3 }, signal: state.summaryController.signal,
      });
      if (sequence !== state.summarySequence || state.selected?.report_id !== report.report_id) return;
      if (result.source_revision !== report.revision) throw new Error("요약 중 보고서가 변경되었습니다. 보고서를 다시 선택한 뒤 요약해 주세요.");
      if (typeof result.summary !== "string" || !result.summary.trim()) throw new Error("요약 결과가 비어 있습니다. 다시 시도해 주세요.");
      $("summary-output").textContent = result.summary;
      $("summary-output").hidden = false;
      $("summary-status").textContent = `보고서 #${result.report_id} · 수정 버전 ${result.source_revision}의 본문을 요약했습니다.`;
    } catch (error) {
      if (error.name === "AbortError" || sequence !== state.summarySequence) return;
      showMessage("summary-error", error.message);
      $("summary-status").textContent = "요약을 완료하지 못했습니다. 원문을 확인하거나 다시 시도해 주세요.";
    } finally {
      if (sequence === state.summarySequence) {
        state.summaryBusy = false;
        $("summary-button").disabled = false;
        $("summary-button").classList.remove("is-loading");
        $("summary-output").setAttribute("aria-busy", "false");
      }
    }
  }

  // 종류별 필드를 만들고, 서버가 요구하는 details 객체만 전송합니다.
  function renderEditorFields(details = {}) {
    const code = $("field-category").value;
    $("detail-fields").replaceChildren();
    for (const [name, label, type, optional] of CATEGORIES[code]?.fields || []) {
      const wrapper = textElement("div", type === "textarea" ? "field field-full" : "field", "");
      const caption = textElement("label", "", `${label}${optional ? " (선택)" : ""}`);
      caption.htmlFor = `detail-${name}`;
      const input = document.createElement(type === "textarea" ? "textarea" : "input");
      input.id = `detail-${name}`;
      input.name = name;
      input.required = !optional;
      if (type === "textarea") input.rows = 2;
      else input.type = type;
      if (type === "datetime-local") {
        input.value = details[name] ? toMeetingInput(details[name]) : "";
        input.step = "60";
      } else input.value = details[name] ?? (type === "date" ? todayInKorea() : "");
      wrapper.append(caption, input);
      $("detail-fields").append(wrapper);
    }
    const promptEditing = code === "PROMPT" && !!state.editor?.original;
    $("field-content").readOnly = promptEditing;
    $("prompt-note").hidden = code !== "PROMPT";
    $("prompt-note").textContent = promptEditing
      ? "이 화면에서는 프롬프트 본문을 바꿀 수 없습니다. 제목·작성자·개요·사용 목적은 수정할 수 있습니다."
      : "본문에 사용할 프롬프트를 작성하세요. 같은 내용이 프롬프트 원문으로 함께 저장됩니다.";
  }
  function openEditor(report = null) {
    if (state.saving || state.deleting) return;
    state.editor = { original: report };
    $("editor-form").reset();
    for (const input of $("editor-form").querySelectorAll("input, textarea, select")) input.setCustomValidity("");
    showMessage("editor-error", "");
    $("editor-title").textContent = report ? "보고서 수정" : "새 보고서";
    $("editor-save").textContent = report ? "수정 내용 저장" : "보고서 등록";
    $("field-category").value = report?.category_code || "DAILY_WORK";
    $("field-category").disabled = !!report;
    for (const key of ["title", "author", "overview", "content"]) $(`field-${key}`).value = report?.[key] || "";
    renderEditorFields(report?.details || {});
    $("editor-dialog").showModal();
    $("field-title").focus();
  }
  function closeEditor() {
    if (state.saving) return;
    $("editor-dialog").close();
    state.editor = null;
  }
  function setEditorBusy(busy) {
    state.saving = busy;
    for (const element of $("editor-dialog").querySelectorAll("input, textarea, select, button")) element.disabled = busy;
    if (!busy) $("field-category").disabled = !!state.editor?.original;
    $("editor-save").textContent = busy ? "저장 중…" : (state.editor?.original ? "수정 내용 저장" : "보고서 등록");
    $("editor-form").setAttribute("aria-busy", String(busy));
  }
  function buildPayload() {
    const original = state.editor?.original;
    const code = $("field-category").value;
    const payload = {};
    for (const key of ["title", "author", "overview", "content"]) {
      const input = $(`field-${key}`);
      const value = input.value;
      const minLength = key === "overview" ? 10 : 1;
      if (value.trim().length < minLength) {
        input.setCustomValidity(`${FIELD_LABELS[key]}은(는) 앞뒤 공백을 제외하고 ${minLength}자 이상 입력해 주세요.`);
        input.reportValidity();
        return null;
      }
      payload[key] = value;
    }
    payload.details = {};
    for (const [name, label, type, optional] of CATEGORIES[code].fields) {
      const input = $(`detail-${name}`);
      let value = input.value;
      if (!optional && !value.trim()) {
        input.setCustomValidity(`${label}을(를) 입력해 주세요.`);
        input.reportValidity();
        return null;
      }
      if (type === "datetime-local" && value) {
        const originalValue = original?.details?.[name];
        // 바꾸지 않은 시각은 원본의 초·소수초까지 그대로 보존합니다.
        if (originalValue && value === toMeetingInput(originalValue)) value = originalValue;
        else {
          const date = new Date(`${value}+09:00`);
          if (!Number.isFinite(date.getTime())) {
            input.setCustomValidity("올바른 한국 시간의 회의 일시를 입력해 주세요.");
            input.reportValidity();
            return null;
          }
          value = date.toISOString();
        }
      }
      payload.details[name] = value;
    }
    if (original) {
      payload.expected_revision = original.revision;
      if (code === "PROMPT") payload.content = original.content;
    } else {
      payload.category_code = code;
      if (code === "PROMPT") payload.details.prompt_text = payload.content;
    }
    return payload;
  }
  async function saveReport(event) {
    event.preventDefault();
    if (state.saving) return;
    const payload = buildPayload();
    if (!payload) return;
    const original = state.editor?.original;
    showMessage("editor-error", "");
    setEditorBusy(true);
    let reportId;
    try {
      const result = await api(original ? `${API}/reports/${original.report_id}` : `${API}/reports`, {
        method: original ? "PUT" : "POST", body: payload,
      });
      reportId = original?.report_id || result.report_id;
    } catch (error) {
      showMessage("editor-error", `${error.message}${error.status === 409 ? " 입력 내용은 유지됩니다. 필요한 내용을 복사한 후 닫고 보고서를 다시 선택해 주세요." : ""}`);
      $("editor-error").scrollIntoView({ block: "nearest", behavior: "auto" });
      return;
    } finally { setEditorBusy(false); }
    closeEditor();
    resetSummary();
    announce(original ? "보고서를 수정했습니다." : "새 보고서를 등록했습니다.");
    $("search-mode").value = "title";
    $("search-query").value = "";
    updateSearchHint();
    await loadReports({ mode: "title", query: "", offset: 0, selectId: reportId });
  }
  function openDelete() {
    if (!state.selected || state.deleting) return;
    state.deleteTarget = { id: state.selected.report_id, title: state.selected.title };
    $("delete-title-text").textContent = `“${state.deleteTarget.title}”`;
    showMessage("delete-error", "");
    $("delete-dialog").showModal();
    $("delete-cancel").focus();
  }
  async function deleteReport() {
    if (!state.deleteTarget || state.deleting) return;
    state.deleting = true;
    $("delete-confirm").disabled = true;
    $("delete-cancel").disabled = true;
    $("delete-confirm").textContent = "삭제 중…";
    try { await api(`${API}/reports/${state.deleteTarget.id}`, { method: "DELETE" }); }
    catch (error) { showMessage("delete-error", error.message); return; }
    finally {
      state.deleting = false;
      $("delete-confirm").disabled = false;
      $("delete-cancel").disabled = false;
      $("delete-confirm").textContent = "삭제하기";
    }
    $("delete-dialog").close();
    state.deleteTarget = null;
    clearDetail();
    announce("보고서를 삭제했습니다.");
    const offset = state.items.length <= 1 ? Math.max(0, state.offset - PAGE_SIZE) : state.offset;
    await loadReports({ offset });
  }
  function updateSearchHint() {
    const similar = $("search-mode").value === "similar";
    $("search-query").placeholder = similar ? "예: 검색 결과의 정확도를 높이는 방법" : "보고서 제목을 입력하세요";
    $("search-query").required = similar;
    $("search-query").setCustomValidity("");
  }
  function bindEvents() {
    $("search-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const query = $("search-query").value.trim();
      const mode = $("search-mode").value;
      if (mode === "similar" && !query) {
        $("search-query").setCustomValidity("관련 보고서를 찾을 검색어를 입력해 주세요.");
        $("search-query").reportValidity();
        return;
      }
      loadReports({ mode, query, offset: 0 });
    });
    $("search-mode").addEventListener("change", updateSearchHint);
    $("search-query").addEventListener("input", () => $("search-query").setCustomValidity(""));
    $("reset-search").addEventListener("click", () => {
      $("search-mode").value = "title";
      $("search-query").value = "";
      updateSearchHint();
      loadReports({ mode: "title", query: "", offset: 0 });
      checkHealth();
    });
    $("previous-page").addEventListener("click", () => loadReports({ offset: Math.max(0, state.offset - PAGE_SIZE) }));
    $("next-page").addEventListener("click", () => loadReports({ offset: state.offset + PAGE_SIZE }));
    $("health-button").addEventListener("click", checkHealth);
    $("summary-button").addEventListener("click", summarizeReport);
    $("new-report-button").addEventListener("click", () => openEditor());
    $("edit-report-button").addEventListener("click", () => state.selected && openEditor(state.selected));
    $("field-category").addEventListener("change", () => renderEditorFields());
    $("editor-form").addEventListener("submit", saveReport);
    $("editor-form").addEventListener("input", (event) => event.target.setCustomValidity?.(""));
    $("editor-close").addEventListener("click", closeEditor);
    $("editor-cancel").addEventListener("click", closeEditor);
    $("editor-dialog").addEventListener("cancel", (event) => { if (state.saving) event.preventDefault(); });
    $("delete-report-button").addEventListener("click", openDelete);
    $("delete-confirm").addEventListener("click", deleteReport);
    $("delete-cancel").addEventListener("click", () => { if (!state.deleting) $("delete-dialog").close(); });
    $("delete-dialog").addEventListener("cancel", (event) => { if (state.deleting) event.preventDefault(); });
  }
  populateCategories();
  bindEvents();
  updateSearchHint();
  if (window.location.protocol === "file:") {
    showMessage("list-message", "서버를 실행한 뒤 http://127.0.0.1:8000 으로 접속해 주세요. HTML 파일을 직접 열면 API에 연결되지 않습니다.");
    $("health-label").textContent = "서버로 접속해 주세요";
  } else {
    // 독립된 초기 조회입니다. LLM 요약은 사용자가 버튼을 눌렀을 때만 호출합니다.
    checkHealth();
    loadCategories();
    loadReports({ mode: "title", query: "", offset: 0 });
  }
})();
