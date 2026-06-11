"use strict";

const $ = (id) => document.getElementById(id);
const ADMIN_VIEWS = new Set(["dashboard", "questions", "participants", "recovery", "courses"]);
const state = {
  sb: null,
  session: null,
  me: null,
  houses: [],
  courses: [],
  questions: [],
  filter: "all",
  loaded: new Set(),
  toastTimer: null,
};

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function clear(node) {
  node.replaceChildren();
}

function toast(message, type = "info", duration = 7000) {
  let node = $("adminToast");
  if (!node) {
    node = element("div", "", "toast");
    node.id = "adminToast";
    document.body.append(node);
  }
  window.clearTimeout(state.toastTimer);
  node.textContent = message;
  node.className = `toast ${type}`;
  requestAnimationFrame(() => node.classList.add("show"));
  state.toastTimer = window.setTimeout(() => node.classList.remove("show"), duration);
}

function safeHttpUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function formatDate(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("es-PE", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatSeconds(value) {
  if (!value) return "-";
  const minutes = Math.floor(value / 60);
  const seconds = value % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function appendCell(row, value) {
  row.append(element("td", value));
}

function actionLink(label, href) {
  const link = element("a", label, "table-link");
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

function houseGradient(code) {
  const gradients = {
    gryffindor: "linear-gradient(135deg, #740001, #d3a625)",
    hufflepuff: "linear-gradient(135deg, #372e29, #ecb939)",
    slytherin: "linear-gradient(135deg, #1a472a, #aaaaaa)",
    ravenclaw: "linear-gradient(135deg, #0e1a40, #946b2d)",
    thunderbird: "linear-gradient(135deg, #3c1053, #f5b335)",
  };
  return gradients[code] || "linear-gradient(135deg, #31213b, #ad7fd1)";
}

function redirectToAcademy() {
  window.location.replace("index.html");
}

async function rpc(name, params) {
  const { data, error } = await state.sb.rpc(name, params);
  if (error) throw error;
  return data;
}

async function guardFocalAccess() {
  const config = window.ACADEMY_CONFIG;
  if (!config?.SUPABASE_URL || !config?.SUPABASE_ANON_KEY || !window.supabase) {
    throw new Error("Falta configurar Supabase.");
  }

  state.sb = window.supabase.createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY);
  const { data: sessionData, error: sessionError } = await state.sb.auth.getSession();
  if (sessionError || !sessionData.session) return redirectToAcademy();
  state.session = sessionData.session;

  const { data: profile, error: profileError } = await state.sb
    .from("academy_users")
    .select("*, house:academy_houses(*)")
    .eq("auth_user_id", state.session.user.id)
    .maybeSingle();

  if (profileError || !profile || !profile.active || !["focal", "admin"].includes(profile.role)) {
    return redirectToAcademy();
  }

  state.me = profile;
}

async function loadBaseData() {
  const [housesResult, coursesResult] = await Promise.all([
    state.sb.from("academy_houses").select("*").order("name"),
    state.sb.from("academy_courses").select("*").eq("active", true).order("sort_order"),
  ]);
  if (housesResult.error) throw housesResult.error;
  if (coursesResult.error) throw coursesResult.error;
  state.houses = housesResult.data || [];
  state.courses = coursesResult.data || [];
}

function renderProfile() {
  $("adminProfileIcon").textContent = state.me.house?.icon || "F";
  $("adminProfileName").textContent = state.me.full_name;
  $("adminProfileMeta").textContent = `${state.me.role === "admin" ? "Administrador" : "Focal"} · ${state.me.house?.name || "Sin casa"}`;
  if (state.me.role !== "admin") {
    state.filter = "mine";
    $("adminHouseFilter").value = "mine";
    $("adminHouseFilter").querySelector('option[value="all"]').disabled = true;
  }

  const select = $("questionCourseSelect");
  clear(select);
  state.courses.forEach((course) => {
    const option = element("option", course.title);
    option.value = course.id;
    select.append(option);
  });
}

function filteredByHouse(rows) {
  if (state.filter !== "mine") return rows;
  return rows.filter((row) => row.house === state.me.house?.name);
}

async function loadDashboard() {
  const [summary, houseScores] = await Promise.all([
    rpc("academy_get_admin_summary"),
    rpc("academy_get_house_scores"),
  ]);
  const participants = filteredByHouse(summary.filter((row) => row.role === "student"));
  const scores = state.filter === "mine"
    ? houseScores.filter((row) => row.house === state.me.house?.name)
    : houseScores;
  const topWizard = [...participants].sort((a, b) => Number(b.xp) - Number(a.xp))[0];
  const topHouse = [...scores].sort((a, b) => Number(b.total_points) - Number(a.total_points))[0];

  $("adminParticipants").textContent = String(participants.length);
  $("adminTopHouse").textContent = topHouse ? `${topHouse.house} · ${topHouse.total_points} pts` : "-";
  $("adminTopWizard").textContent = topWizard ? `${topWizard.full_name} · ${topWizard.xp} XP` : "-";
  $("adminFilterLabel").textContent = state.filter === "mine" ? state.me.house?.name || "Mi casa" : "Todas las casas";

  const grid = $("adminHousesGrid");
  clear(grid);
  scores.forEach((score) => {
    const house = state.houses.find((item) => item.name === score.house);
    const card = element("article", "", "admin-house-card");
    card.style.background = houseGradient(house?.code);
    card.append(
      element("div", house?.icon || "★", "admin-house-icon"),
      element("h3", score.house),
      element("strong", `${score.total_points} puntos`),
      element("span", score.leader_name || "")
    );
    grid.append(card);
  });
}

async function setParticipantActive(userId, active) {
  await rpc("academy_admin_set_participant_active", {
    p_user_id: userId,
    p_active: active,
  });
  state.loaded.delete("dashboard");
  state.loaded.delete("participants");
  state.loaded.delete("courses");
  await loadParticipants();
  toast(active ? "Participante habilitado." : "Participante deshabilitado.");
}

async function sendPasswordRecovery(email) {
  const { error } = await state.sb.rpc("academy_request_password_reset", { p_indra_email: email });
  if (error) throw error;
  state.loaded.delete("recovery");
  toast(`Solicitud de recuperación registrada para ${email}.`);
}

async function setTemporaryPassword(request, password) {
  if (password.length < 8) throw new Error("La contraseña temporal debe tener al menos 8 caracteres.");
  const { data, error } = await state.sb.functions.invoke("set-temporary-password", {
    body: { request_type: request.request_type, request_id: request.request_id, temporary_password: password },
  });
  if (error) throw error;
  if (!data?.ok) throw new Error(data?.error || "No se pudo asignar la contraseña temporal.");
  state.loaded.delete("recovery");
  await loadRecoveryRequests();
  toast("Contraseña temporal asignada.", "success");
}

function renderRecoveryCount(count) {
  const badge = $("recoveryCount");
  badge.textContent = String(count);
  badge.classList.toggle("hidden", count === 0);
}

async function loadRecoveryRequests() {
  const requests = await rpc("academy_admin_get_access_requests");
  renderRecoveryCount(requests.length);
  const container = $("recoveryRequests");
  clear(container);
  if (!requests.length) {
    container.append(element("p", "No hay solicitudes pendientes.", "empty-state"));
    return;
  }
  requests.forEach((request) => {
    const card = element("article", "", "recovery-card");
    const info = element("div");
    info.append(
      element("strong", request.full_name),
      element("span", request.indra_email),
      element("span", `${request.request_type === "account" ? "Nueva cuenta" : "Recuperación"} · ${request.house} · Solicitado ${formatDate(request.requested_at)}`)
    );
    const controls = element("div", "", "recovery-controls");
    const password = document.createElement("input");
    password.type = "password";
    password.minLength = 8;
    password.placeholder = "Contraseña temporal";
    password.autocomplete = "new-password";
    const save = element("button", "Asignar temporal", "primary");
    save.type = "button";
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        await setTemporaryPassword(request, password.value);
      } catch (error) {
        toast(error.message, "error", 10000);
        save.disabled = false;
      }
    });
    controls.append(password, save);
    card.append(info, controls);
    container.append(card);
  });
}

async function loadParticipants() {
  const summary = await rpc("academy_get_admin_summary");
  const participants = filteredByHouse(summary.filter((row) => row.role === "student"));
  const body = $("adminRows");
  clear(body);

  participants.forEach((participant) => {
    const row = document.createElement("tr");
    appendCell(row, participant.full_name);
    appendCell(row, participant.indra_email);
    appendCell(row, participant.house);
    appendCell(row, participant.active ? "Activo" : "Deshabilitado");
    appendCell(row, String(participant.completed_courses));
    appendCell(row, String(participant.valid_points));
    appendCell(row, String(participant.xp));

    const actions = document.createElement("td");
    const toggle = element("button", participant.active ? "Deshabilitar" : "Habilitar", "btn small");
    toggle.type = "button";
    toggle.addEventListener("click", async () => {
      toggle.disabled = true;
      try {
        await setParticipantActive(participant.user_id, !participant.active);
      } catch (error) {
        toast(error.message, "error", 9000);
        toggle.disabled = false;
      }
    });
    const recovery = element("button", "Recuperar contraseña", "btn small ghost");
    recovery.type = "button";
    recovery.addEventListener("click", async () => {
      recovery.disabled = true;
      try {
        await sendPasswordRecovery(participant.indra_email);
      } catch (error) {
        toast(error.message, "error", 9000);
      } finally {
        recovery.disabled = false;
      }
    });
    actions.append(toggle, recovery);
    row.append(actions);
    body.append(row);
  });
}

async function loadCourseDetails() {
  const details = filteredByHouse(
    (await rpc("academy_get_admin_course_detail")).filter((row) => row.role === "student")
  );
  const body = $("adminCourseRows");
  clear(body);

  details.forEach((detail) => {
    const row = document.createElement("tr");
    appendCell(row, detail.full_name);
    appendCell(row, detail.house);
    appendCell(row, detail.course_title);
    appendCell(row, detail.completed ? "Completado" : "Pendiente");
    appendCell(row, detail.best_score ?? "-");
    appendCell(row, detail.attempts ?? 0);
    appendCell(row, formatSeconds(detail.best_quiz_time_seconds));
    appendCell(row, formatDate(detail.completed_at));
    const certificate = document.createElement("td");
    const url = safeHttpUrl(detail.certificate_url);
    certificate.append(url ? actionLink("Ver certificado", url) : document.createTextNode("-"));
    row.append(certificate);
    body.append(row);
  });
}

function addQuestionOptionRow(value = "", correct = false) {
  const container = $("questionOptions");
  const row = element("div", "", "question-option-row");
  const radio = document.createElement("input");
  radio.type = "radio";
  radio.name = "correctQuestionOption";
  radio.checked = correct;
  radio.setAttribute("aria-label", "Respuesta correcta");
  const input = document.createElement("input");
  input.type = "text";
  input.value = value;
  input.maxLength = 300;
  input.placeholder = "Texto de la opción";
  const remove = element("button", "Quitar", "btn small ghost");
  remove.type = "button";
  remove.addEventListener("click", () => row.remove());
  row.append(radio, input, remove);
  container.append(row);
}

function renderQuestionEditor(question = null) {
  $("questionId").value = question?.id || "";
  $("questionText").value = question?.question_text || "";
  $("questionSortOrder").value = question?.sort_order || state.questions.length + 1;
  $("questionActive").checked = question?.active ?? true;
  clear($("questionOptions"));
  const options = question?.options || ["", "", "", ""];
  options.forEach((option, index) => addQuestionOptionRow(option, index === question?.correct_option));
}

function renderQuestionList() {
  const list = $("questionList");
  clear(list);
  if (!state.questions.length) {
    list.append(element("p", "Este curso todavía no tiene preguntas.", "muted"));
    return;
  }

  state.questions.forEach((question) => {
    const card = element("article", "", "question-list-item");
    const title = element("h4", `${question.sort_order}. ${question.question_text}`);
    const status = element("span", question.active ? "Activa" : "Inactiva", "admin-status");
    const actions = element("div", "", "question-actions");
    const edit = element("button", "Editar", "btn small");
    edit.type = "button";
    edit.addEventListener("click", () => renderQuestionEditor(question));
    const remove = element("button", "Eliminar", "btn small ghost");
    remove.type = "button";
    remove.addEventListener("click", async () => {
      if (!window.confirm("¿Eliminar esta pregunta?")) return;
      try {
        await rpc("academy_admin_delete_question", { p_question_id: question.id });
        await loadQuestions();
        toast("Pregunta eliminada.");
      } catch (error) {
        toast(error.message, "error", 9000);
      }
    });
    actions.append(edit, remove);
    card.append(title, status, actions);
    list.append(card);
  });
}

async function loadQuestions() {
  const courseId = $("questionCourseSelect").value;
  if (!courseId) return;
  state.questions = await rpc("academy_admin_get_questions", { p_course_id: courseId });
  renderQuestionList();
  renderQuestionEditor();
}

async function saveQuestion() {
  const optionRows = [...$("questionOptions").querySelectorAll(".question-option-row")];
  const options = optionRows.map((row) => row.querySelector('input[type="text"]').value.trim());
  const correctOption = optionRows.findIndex((row) => row.querySelector('input[type="radio"]').checked);
  if (options.length < 2 || options.some((option) => !option) || correctOption < 0) {
    throw new Error("Completa al menos dos opciones y selecciona la respuesta correcta.");
  }
  await rpc("academy_admin_save_question", {
    p_question_id: $("questionId").value || null,
    p_course_id: $("questionCourseSelect").value,
    p_question_text: $("questionText").value.trim(),
    p_options: options,
    p_correct_option: correctOption,
    p_active: $("questionActive").checked,
    p_sort_order: Number($("questionSortOrder").value),
  });
  await loadQuestions();
  toast("Pregunta guardada.");
}

async function loadView(view, force = false) {
  if (!force && state.loaded.has(view)) return;
  if (view === "dashboard") await loadDashboard();
  if (view === "questions") await loadQuestions();
  if (view === "participants") await loadParticipants();
  if (view === "recovery") await loadRecoveryRequests();
  if (view === "courses") await loadCourseDetails();
  state.loaded.add(view);
}

async function showView(view) {
  if (!ADMIN_VIEWS.has(view)) view = "dashboard";
  document.querySelectorAll("[data-admin-view]").forEach((link) => {
    link.classList.toggle("active", link.dataset.adminView === view);
  });
  document.querySelectorAll(".admin-view").forEach((section) => {
    section.hidden = section.id !== `adminView${view[0].toUpperCase()}${view.slice(1)}`;
  });
  const titles = {
    dashboard: "Dashboard",
    questions: "Preguntas del examen",
    participants: "Avances por participante",
    recovery: "Recuperación de cuentas",
    courses: "Detalle de cursos",
  };
  $("adminPageTitle").textContent = titles[view];
  await loadView(view);
}

function currentView() {
  const view = window.location.hash.replace("#", "");
  return ADMIN_VIEWS.has(view) ? view : "dashboard";
}

function bindEvents() {
  window.addEventListener("hashchange", () => showView(currentView()).catch((error) => toast(error.message, "error", 9000)));
  $("adminHouseFilter").addEventListener("change", async (event) => {
    state.filter = event.target.value;
    ["dashboard", "participants", "courses"].forEach((view) => state.loaded.delete(view));
    try {
      await loadView(currentView(), true);
    } catch (error) {
      toast(error.message, "error", 9000);
    }
  });
  $("questionCourseSelect").addEventListener("change", () => loadQuestions().catch((error) => toast(error.message, "error", 9000)));
  $("newQuestionBtn").addEventListener("click", () => renderQuestionEditor());
  $("addQuestionOptionBtn").addEventListener("click", () => addQuestionOptionRow());
  $("saveQuestionBtn").addEventListener("click", async () => {
    try {
      await saveQuestion();
    } catch (error) {
      toast(error.message, "error", 9000);
    }
  });
  $("adminChangePasswordBtn").addEventListener("click", () => $("adminPasswordDialog").showModal());
  $("adminClosePasswordBtn").addEventListener("click", () => $("adminPasswordDialog").close());
  $("adminSavePasswordBtn").addEventListener("click", async () => {
    const password = $("adminNewPassword").value;
    if (password.length < 8 || password !== $("adminConfirmPassword").value) {
      return toast("Las contraseñas deben coincidir y tener al menos 8 caracteres.", "warning", 9000);
    }
    const { error } = await state.sb.auth.updateUser({ password });
    if (error) return toast(error.message, "error", 9000);
    $("adminPasswordDialog").close();
    $("adminNewPassword").value = "";
    $("adminConfirmPassword").value = "";
    toast("Contraseña actualizada.");
  });
  $("adminLogoutBtn").addEventListener("click", async () => {
    await state.sb.auth.signOut();
    redirectToAcademy();
  });
}

async function init() {
  try {
    await guardFocalAccess();
    await loadBaseData();
    renderProfile();
    bindEvents();
    const pendingRequests = await rpc("academy_admin_get_access_requests");
    renderRecoveryCount(pendingRequests.length);
    $("adminGuard").hidden = true;
    $("adminApp").classList.remove("hidden");
    await showView(currentView());
  } catch (error) {
    $("adminGuard").textContent = error.message || "No se pudo abrir el panel focal.";
  }
}

init();
