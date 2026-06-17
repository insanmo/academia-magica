"use strict";

const $ = (id) => document.getElementById(id);
const ADMIN_VIEWS = new Set(["dashboard", "questions", "participants", "users", "recovery", "courses", "config"]);
const ADMIN_ONLY_VIEWS = new Set(["questions", "users", "config"]);
const state = {
  sb: null,
  session: null,
  me: null,
  houses: [],
  courses: [],
  questions: [],
  levels: [],
  badges: [],
  progressExportRows: [],
  managedUsers: [],
  filter: "all",
  loaded: new Set(),
  toastTimer: null,
  pendingRequestCount: 0,
  recoveryPollTimer: null,
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

function clearSupabaseStorage() {
  [window.localStorage, window.sessionStorage].forEach((store) => {
    if (!store) return;
    Object.keys(store)
      .filter((key) => key.startsWith("sb-") || key.includes("supabase"))
      .forEach((key) => store.removeItem(key));
  });
}

function toDatetimeLocal(value) {
  if (!value) return "";
  const date = new Date(value);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

function fromDatetimeLocal(value) {
  return value ? new Date(value).toISOString() : null;
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

function prepareAdminLayout() {
  const usersView = $("adminViewUsers");
  const userManager = $("userManager");
  if (usersView && userManager && userManager.parentElement !== usersView) {
    usersView.append(userManager);
  }
}

function withTimeout(promise, message, timeoutMs = 15000) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timeoutId));
}

function showGuardError(error) {
  const guard = $("adminGuard");
  const card = element("div", "", "auth-card");
  const retry = element("button", "Reintentar", "primary");
  retry.type = "button";
  retry.addEventListener("click", () => window.location.reload());
  const back = element("a", "Volver a la Academia", "secondary");
  back.href = "index.html";
  card.append(
    element("p", "No se pudo cargar", "overline"),
    element("h1", "Panel Focal"),
    element("p", error?.message || "No se pudo abrir el panel focal.", "intro"),
    retry,
    back
  );
  guard.replaceChildren(card);
}

async function rpc(name, params) {
  const { data, error } = await withTimeout(
    state.sb.rpc(name, params),
    `La consulta ${name} está tardando demasiado. Reintenta en unos segundos.`
  );
  if (error) throw error;
  return data;
}

async function guardFocalAccess() {
  const config = window.ACADEMY_CONFIG;
  if (!config?.SUPABASE_URL || !config?.SUPABASE_ANON_KEY || !window.supabase) {
    throw new Error("Falta configurar Supabase.");
  }

  state.sb = window.supabase.createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY);
  const { data: sessionData, error: sessionError } = await withTimeout(
    state.sb.auth.getSession(),
    "Supabase no respondió al validar la sesión. Reintenta o vuelve a iniciar sesión."
  );
  if (sessionError || !sessionData.session) {
    redirectToAcademy();
    return false;
  }
  state.session = sessionData.session;

  const { data: profile, error: profileError } = await withTimeout(
    state.sb
      .from("academy_users")
      .select("*, house:academy_houses(*)")
      .eq("auth_user_id", state.session.user.id)
      .maybeSingle(),
    "Supabase no respondió al consultar tu perfil."
  );

  if (profileError) throw profileError;
  if (!profile || !profile.active || !["focal", "admin"].includes(profile.role)) {
    redirectToAcademy();
    return false;
  }

  state.me = profile;
  return true;
}

async function loadBaseData() {
  let coursesQuery = state.sb.from("academy_courses").select("*").order("sort_order");
  if (state.me.role !== "admin") coursesQuery = coursesQuery.eq("active", true);
  const [housesResult, coursesResult] = await withTimeout(
    Promise.all([
      state.sb.from("academy_houses").select("*").order("name"),
      coursesQuery,
    ]),
    "Supabase no respondió al cargar casas y cursos."
  );
  if (housesResult.error) throw housesResult.error;
  if (coursesResult.error) throw coursesResult.error;
  state.houses = housesResult.data || [];
  state.courses = coursesResult.data || [];
}

function renderProfile() {
  const isAdmin = state.me.role === "admin";
  $("adminProfileIcon").textContent = state.me.house?.icon || "F";
  $("adminProfileName").textContent = state.me.full_name;
  $("adminProfileMeta").textContent = `${isAdmin ? "Administrador · Acceso a todas las casas" : "Focal"} · ${state.me.house?.name || "Sin casa"}`;
  $("adminPanelName").textContent = isAdmin ? "Panel Focal · Administración" : "Panel Focal";
  $("adminViewLabel").textContent = isAdmin ? "Vista administrativa completa" : "Vista focal";

  document.querySelectorAll("[data-admin-only='true']").forEach((node) => {
    node.classList.toggle("hidden", !isAdmin);
  });

  const filterSelect = $("adminHouseFilter");
  clear(filterSelect);
  if (isAdmin) {
    state.filter = "all";
    const optAll = element("option", "Todas las casas");
    optAll.value = "all";
    filterSelect.append(optAll);
    state.houses.forEach((house) => {
      const opt = element("option", house.name);
      opt.value = house.name;
      filterSelect.append(opt);
    });
    filterSelect.value = "all";
  } else {
    state.filter = "mine";
    const optMine = element("option", `Mi casa (${state.me.house?.name || "Sin casa"})`);
    optMine.value = "mine";
    filterSelect.append(optMine);
    filterSelect.value = "mine";
  }

  const select = $("questionCourseSelect");
  clear(select);
  state.courses.filter((course) => course.has_exam !== false).forEach((course) => {
    const option = element("option", course.title);
    option.value = course.id;
    select.append(option);
  });
}

function filteredByHouse(rows) {
  if (state.filter === "all") return rows;
  if (state.filter === "mine") {
    return rows.filter((row) => row.house === state.me.house?.name);
  }
  return rows.filter((row) => row.house === state.filter);
}

async function loadDashboard() {
  const [summary, houseScores] = await Promise.all([
    rpc("academy_get_admin_summary"),
    rpc("academy_get_house_scores"),
  ]);
  const participants = filteredByHouse(summary.filter((row) => row.role === "student"));
  const scores = state.filter === "all"
    ? houseScores
    : state.filter === "mine"
      ? houseScores.filter((row) => row.house === state.me.house?.name)
      : houseScores.filter((row) => row.house === state.filter);
  const topWizard = [...participants].sort((a, b) => Number(b.xp) - Number(a.xp))[0];
  const topHouse = [...scores].sort((a, b) => Number(b.total_points) - Number(a.total_points))[0];

  $("adminParticipants").textContent = String(participants.length);
  $("adminTopHouse").textContent = topHouse ? `${topHouse.house} · ${topHouse.total_points} pts` : "-";
  $("adminTopWizard").textContent = topWizard ? `${topWizard.full_name} · ${topWizard.xp} XP` : "-";

  let filterLabel = "Todas";
  if (state.filter === "mine") {
    filterLabel = state.me.house?.name || "Mi casa";
  } else if (state.filter !== "all") {
    filterLabel = state.filter;
  }
  $("adminFilterLabel").textContent = filterLabel;

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
    body: { request_type: request.request_type, request_id: request.request_id, indra_email: request.indra_email, temporary_password: password },
  });
  if (error) throw error;
  if (!data?.ok) throw new Error(data?.error || "No se pudo asignar la contraseña temporal.");
  state.loaded.delete("recovery");
  await loadRecoveryRequests();
  toast("Contraseña temporal asignada.", "success");
}

async function cancelAccessRequest(request) {
  const label = request.request_type === "account" ? "solicitud de nueva cuenta" : "solicitud de recuperacion";
  if (!window.confirm(`Descartar esta ${label} de ${request.full_name}?`)) return;
  await rpc("academy_admin_cancel_access_request", {
    p_request_type: request.request_type,
    p_request_id: request.request_id,
  });
  state.loaded.delete("recovery");
  await loadRecoveryRequests();
  toast("Solicitud descartada.", "success");
}

function renderRecoveryCount(count) {
  const badge = $("recoveryCount");
  badge.textContent = String(count);
  badge.classList.toggle("hidden", count === 0);
  state.pendingRequestCount = count;
}

async function checkRecoveryAlerts({ notify = true } = {}) {
  const requests = await rpc("academy_admin_get_access_requests");
  const previous = state.pendingRequestCount;
  renderRecoveryCount(requests.length);
  if (notify && requests.length > previous) {
    const difference = requests.length - previous;
    toast(`Nueva solicitud pendiente (${difference}). Revisa Recuperacion de cuentas.`, "warning", 10000);
    state.loaded.delete("recovery");
  }
  return requests;
}

function startRecoveryAlerts() {
  window.clearInterval(state.recoveryPollTimer);
  state.recoveryPollTimer = window.setInterval(() => {
    checkRecoveryAlerts().catch((error) => console.error("No se pudo revisar solicitudes pendientes:", error));
  }, 60000);
}

function csvCell(value) {
  const text = String(value ?? "").replace(/\r?\n/g, " ");
  return `"${text.replace(/"/g, '""')}"`;
}

function exportProgress() {
  const rows = state.progressExportRows || [];
  if (!rows.length) {
    toast("No hay datos para exportar.", "warning");
    return;
  }
  const header = ["Participante", "Correo", "Casa", "Curso", "Estado", "XP ganado", "Nota", "Intentos", "Tiempo", "Fecha aprobacion", "Certificado", "Tarea"];
  const body = rows.map((row) => [
    row.full_name,
    row.indra_email,
    row.house,
    row.course_title,
    row.completed ? "Completado" : "Pendiente",
    row.earned_xp ?? 0,
    row.best_score ?? "",
    row.attempts ?? 0,
    formatSeconds(row.best_quiz_time_seconds),
    formatDate(row.completed_at),
    row.certificate_url || "",
    row.assignment_url || "",
  ]);
  const csv = "\ufeff" + [header, ...body].map((line) => line.map(csvCell).join(";")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `avances-cursos-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function manageUser(action, payload = {}) {
  const { data, error } = await state.sb.functions.invoke("manage-academy-user", {
    body: { action, ...payload },
  });
  if (error) throw error;
  if (!data?.ok) throw new Error(data?.error || "No se pudo completar la accion.");
  return data;
}

function roleLabel(role) {
  if (role === "admin") return "Administrador";
  if (role === "focal") return "Focal";
  return "Participante";
}

function fillUserHouseSelect() {
  const select = $("userHouse");
  clear(select);
  const empty = element("option", "Sin casa");
  empty.value = "";
  select.append(empty);
  state.houses.forEach((house) => {
    const option = element("option", house.name);
    option.value = house.id;
    select.append(option);
  });
}

function renderUserEditor(user = null) {
  fillUserHouseSelect();
  $("userId").value = user?.id || "";
  $("userFullName").value = user?.full_name || "";
  $("userEmail").value = user?.indra_email || "";
  $("userRole").value = user?.role || "student";
  $("userHouse").value = user?.house_id || "";
  $("userActive").checked = user?.active ?? true;
  $("userLetterSeen").checked = user?.admission_letter_seen === true;
  $("userTempPassword").value = "";
  $("setUserPasswordBtn").disabled = !user?.id;
}

function userPayloadFromForm() {
  return {
    full_name: $("userFullName").value.trim(),
    indra_email: $("userEmail").value.trim().toLowerCase(),
    role: $("userRole").value,
    house_id: $("userHouse").value || null,
  };
}

async function loadUserManager() {
  const manager = $("userManager");
  if (state.me.role !== "admin") {
    manager.classList.add("hidden");
    return;
  }
  manager.classList.remove("hidden");
  fillUserHouseSelect();
  const data = await manageUser("list");
  state.managedUsers = data.users || [];
  const body = $("adminUsersRows");
  clear(body);
  state.managedUsers.forEach((user) => {
    const row = document.createElement("tr");
    appendCell(row, user.full_name);
    appendCell(row, user.indra_email);
    appendCell(row, roleLabel(user.role));
    appendCell(row, user.house?.name || "Sin casa");
    appendCell(row, user.active ? "Activo" : "Deshabilitado");
    appendCell(row, user.admission_letter_seen ? "Vista" : "Pendiente");
    appendCell(row, user.must_change_password ? "Debe cambiar" : "-");
    appendCell(row, user.auth_user_id ? "Vinculado" : "Sin Auth");

    const actions = document.createElement("td");
    const edit = element("button", "Editar", "btn small");
    edit.type = "button";
    edit.addEventListener("click", () => renderUserEditor(user));
    const password = element("button", "Temporal", "btn small ghost");
    password.type = "button";
    password.addEventListener("click", () => {
      renderUserEditor(user);
      $("userTempPassword").focus();
    });
    const disable = element("button", user.active ? "Deshabilitar" : "Habilitar", "btn small ghost");
    disable.type = "button";
    disable.addEventListener("click", async () => {
      disable.disabled = true;
      try {
        if (user.active) {
          await manageUser("disable", { user_id: user.id });
        } else {
          await manageUser("update", {
            user_id: user.id,
            user: {
              full_name: user.full_name,
              indra_email: user.indra_email,
              role: user.role,
              house_id: user.house_id,
            },
            active: true,
            admission_letter_seen: user.admission_letter_seen === true,
          });
        }
        await refreshUserData();
        toast(user.active ? "Usuario deshabilitado." : "Usuario habilitado.", "success");
      } catch (error) {
        toast(error.message, "error", 9000);
        disable.disabled = false;
      }
    });
    const remove = element("button", "Eliminar", "btn small danger");
    remove.type = "button";
    remove.addEventListener("click", async () => {
      if (!window.confirm(`Eliminar permanentemente a ${user.full_name}? Tambien se eliminaran sus avances e intentos.`)) return;
      remove.disabled = true;
      try {
        await manageUser("delete", { user_id: user.id });
        await refreshUserData();
        toast("Usuario eliminado.", "success");
      } catch (error) {
        toast(error.message, "error", 9000);
        remove.disabled = false;
      }
    });
    actions.append(edit, password, disable, remove);
    row.append(actions);
    body.append(row);
  });
}

async function refreshUserData() {
  state.loaded.delete("dashboard");
  state.loaded.delete("participants");
  state.loaded.delete("users");
  state.loaded.delete("recovery");
  await loadUserManager();
  renderUserEditor();
}

async function saveManagedUser() {
  const userId = $("userId").value;
  const temporaryPassword = $("userTempPassword").value;
  const payload = {
    user: userPayloadFromForm(),
    active: $("userActive").checked,
    admission_letter_seen: $("userLetterSeen").checked,
  };
  if (temporaryPassword) payload.temporary_password = temporaryPassword;
  await manageUser(userId ? "update" : "create", userId ? { user_id: userId, ...payload } : payload);
  if (temporaryPassword && userId) {
    await manageUser("set_password", { user_id: userId, temporary_password: temporaryPassword });
  }
  await refreshUserData();
  toast(userId ? "Usuario actualizado." : "Usuario creado.", "success");
}

async function setManagedPassword() {
  const userId = $("userId").value;
  const temporaryPassword = $("userTempPassword").value;
  if (!userId) throw new Error("Selecciona un usuario primero.");
  await manageUser("set_password", { user_id: userId, temporary_password: temporaryPassword });
  await refreshUserData();
  toast("Contraseña temporal asignada.", "success");
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
        state.loaded.delete("recovery");
        await loadRecoveryRequests();
        toast(error.message, "error", 10000);
        save.disabled = false;
      }
    });
    const discard = element("button", "Descartar", "danger");
    discard.type = "button";
    discard.addEventListener("click", async () => {
      discard.disabled = true;
      try {
        await cancelAccessRequest(request);
      } catch (error) {
        toast(error.message, "error", 10000);
        discard.disabled = false;
      }
    });
    controls.append(password, save, discard);
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
  renderCourseManager();
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
    appendCell(row, detail.earned_xp ?? 0);
    appendCell(row, detail.best_score ?? "-");
    appendCell(row, detail.attempts ?? 0);
    appendCell(row, formatSeconds(detail.best_quiz_time_seconds));
    appendCell(row, formatDate(detail.completed_at));
    const certificate = document.createElement("td");
    const url = safeHttpUrl(detail.certificate_url);
    certificate.append(url ? actionLink("Ver certificado", url) : document.createTextNode("-"));
    row.append(certificate);
    const assignment = document.createElement("td");
    const assignmentUrl = safeHttpUrl(detail.assignment_url);
    assignment.append(assignmentUrl ? actionLink("Ver tarea", assignmentUrl) : document.createTextNode("-"));
    row.append(assignment);
    body.append(row);
  });
}

async function loadParticipants() {
  const [summary, courseDetails] = await Promise.all([
    rpc("academy_get_admin_summary"),
    rpc("academy_get_admin_course_detail"),
  ]);
  const participants = filteredByHouse(summary.filter((row) => row.role === "student"));
  const details = filteredByHouse(courseDetails.filter((row) => row.role === "student"));
  state.progressExportRows = details;
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
    if (state.me.role === "admin") {
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
      const recovery = element("button", "Recuperar contrasena", "btn small ghost");
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
    } else {
      actions.append(document.createTextNode("Solo lectura"));
    }
    row.append(actions);
    body.append(row);
  });

  const detailBody = $("adminCourseRows");
  clear(detailBody);
  details.forEach((detail) => {
    const row = document.createElement("tr");
    appendCell(row, detail.full_name);
    appendCell(row, detail.indra_email);
    appendCell(row, detail.house);
    appendCell(row, detail.course_title);
    appendCell(row, detail.completed ? "Completado" : "Pendiente");
    appendCell(row, detail.earned_xp ?? 0);
    appendCell(row, detail.best_score ?? "-");
    appendCell(row, detail.attempts ?? 0);
    appendCell(row, formatSeconds(detail.best_quiz_time_seconds));
    appendCell(row, formatDate(detail.completed_at));
    const certificate = document.createElement("td");
    const certUrl = safeHttpUrl(detail.certificate_url);
    certificate.append(certUrl ? actionLink("Ver certificado", certUrl) : document.createTextNode("-"));
    row.append(certificate);
    const assignment = document.createElement("td");
    const assignmentUrl = safeHttpUrl(detail.assignment_url);
    assignment.append(assignmentUrl ? actionLink("Ver tarea", assignmentUrl) : document.createTextNode("-"));
    row.append(assignment);
    detailBody.append(row);
  });
}

async function loadCourseDetails() {
  renderCourseManager();
}

function renderCourseEditor(course = null) {
  $("courseId").value = course?.id || "";
  $("courseCode").value = course?.code || "";
  $("courseTitle").value = course?.title || "";
  $("courseUrl").value = course?.udemy_url || "";
  $("courseDescription").value = course?.description || "";
  $("courseMaterialUrl").value = course?.material_url || "";
  $("courseMaterialLabel").value = course?.material_label || "";
  $("courseRequiresCertificate").checked = course?.requires_certificate ?? true;
  $("courseHasExam").checked = course?.has_exam ?? true;
  $("courseRequiresAssignment").checked = course?.requires_assignment ?? false;
  $("coursePoints").value = course?.points ?? 50;
  $("courseXp").value = course?.xp ?? 100;
  $("courseQuizDuration").value = course?.quiz_duration_minutes ?? 3;
  $("courseReleaseStatus").value = course?.release_status || "available";
  $("courseAvailableAt").value = toDatetimeLocal(course?.available_at);
  $("courseComingSoonText").value = course?.coming_soon_text || "";
  $("courseActive").checked = course?.active ?? true;
  $("courseSortOrder").value = course?.sort_order ?? Math.max(0, ...state.courses.map((item) => item.sort_order || 0)) + 1;
}

function renderCourseManager() {
  const manager = $("courseManager");
  manager.classList.remove("hidden");
  const isAdmin = state.me.role === "admin";
  $("courseEditor").classList.toggle("hidden", !isAdmin);
  $("newCourseBtn").classList.toggle("hidden", !isAdmin);
  const list = $("courseList");
  clear(list);
  if (!state.courses.length) {
    list.append(element("p", "Todavía no hay cursos configurados.", "empty-state"));
    return;
  }
  state.courses.forEach((course) => {
    const item = element("article", "", "question-list-item");
    const requirements = [
      course.requires_certificate !== false ? "Certificado" : "Sin certificado",
      course.has_exam !== false ? "Examen" : "Sin examen",
      course.requires_assignment ? "Tarea" : "Sin tarea",
      course.has_exam !== false ? `${course.quiz_duration_minutes || 3} min` : null,
      course.release_status === "coming_soon" ? "Proximamente" : "Disponible",
      course.available_at ? `Desde ${formatDate(course.available_at)}` : null,
      course.active ? "Visible" : "Oculto",
    ].filter(Boolean).join(" · ");
    item.append(
      element("h4", `${course.sort_order}. ${course.title}`),
      element("p", requirements, "muted"),
      element("p", course.udemy_url || "Sin enlace de curso", "muted")
    );
    if (isAdmin) {
      const actions = element("div", "", "admin-actions");
      const edit = element("button", "Editar", "secondary");
      edit.type = "button";
      edit.addEventListener("click", () => renderCourseEditor(course));
      const toggle = element("button", course.active ? "Deshabilitar" : "Habilitar", course.active ? "secondary" : "primary");
      toggle.type = "button";
      toggle.addEventListener("click", () => toggleCourseActive(course).catch((error) => toast(error.message, "error", 9000)));
      const remove = element("button", "Eliminar", "danger");
      remove.type = "button";
      remove.addEventListener("click", () => deleteCourse(course).catch((error) => toast(error.message, "error", 9000)));
      actions.append(edit, toggle, remove);
      item.append(actions);
    }
    list.append(item);
  });
}

async function deleteCourse(course) {
  const message = `Eliminar el curso "${course.title}" tambien eliminara sus preguntas, avances, intentos y sesiones asociadas. Esta accion no se puede deshacer.`;
  if (!window.confirm(message)) return;
  await rpc("academy_admin_delete_course", { p_course_id: course.id });
  await loadBaseData();
  renderProfile();
  renderCourseManager();
  renderCourseEditor();
  state.loaded.clear();
  toast("Curso eliminado.", "success");
}

async function toggleCourseActive(course) {
  const nextActive = !course.active;
  await rpc("academy_admin_save_course", {
    p_course_id: course.id,
    p_code: course.code,
    p_title: course.title,
    p_course_url: course.udemy_url || "",
    p_description: course.description || "",
    p_material_url: course.material_url || "",
    p_material_label: course.material_label || "",
    p_requires_certificate: course.requires_certificate !== false,
    p_has_exam: course.has_exam !== false,
    p_requires_assignment: course.requires_assignment === true,
    p_points: Number(course.points || 0),
    p_xp: Number(course.xp || 0),
    p_quiz_duration_minutes: Number(course.quiz_duration_minutes || 3),
    p_release_status: course.release_status || "available",
    p_available_at: course.available_at || null,
    p_coming_soon_text: course.coming_soon_text || "",
    p_active: nextActive,
    p_sort_order: Number(course.sort_order || 0),
  });
  await loadBaseData();
  renderProfile();
  renderCourseManager();
  state.loaded.clear();
  toast(nextActive ? "Curso habilitado para participantes." : "Curso deshabilitado para participantes.", "success");
}

async function saveCourse() {
  const code = $("courseCode").value.trim().toLowerCase();
  const title = $("courseTitle").value.trim();
  if (!/^[a-z0-9][a-z0-9_-]{1,49}$/.test(code)) throw new Error("El código debe usar letras minúsculas, números, guion o guion bajo.");
  if (title.length < 3) throw new Error("Ingresa el nombre del curso.");
  await rpc("academy_admin_save_course", {
    p_course_id: $("courseId").value || null,
    p_code: code,
    p_title: title,
    p_course_url: $("courseUrl").value.trim(),
    p_description: $("courseDescription").value.trim(),
    p_material_url: $("courseMaterialUrl").value.trim(),
    p_material_label: $("courseMaterialLabel").value.trim(),
    p_requires_certificate: $("courseRequiresCertificate").checked,
    p_has_exam: $("courseHasExam").checked,
    p_requires_assignment: $("courseRequiresAssignment").checked,
    p_points: Number($("coursePoints").value),
    p_xp: Number($("courseXp").value),
    p_quiz_duration_minutes: Number($("courseQuizDuration").value),
    p_release_status: $("courseReleaseStatus").value,
    p_available_at: fromDatetimeLocal($("courseAvailableAt").value),
    p_coming_soon_text: $("courseComingSoonText").value.trim(),
    p_active: $("courseActive").checked,
    p_sort_order: Number($("courseSortOrder").value),
  });
  await loadBaseData();
  renderProfile();
  renderCourseManager();
  renderCourseEditor();
  state.loaded.clear();
  toast("Curso guardado.", "success");
}

async function uploadCourseMaterial() {
  const file = $("courseMaterialFile").files[0];
  if (!file) throw new Error("Selecciona un archivo.");
  if (file.size > 25 * 1024 * 1024) throw new Error("El archivo no puede superar 25 MB.");
  const safeName = file.name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  const path = `${state.session.user.id}/${crypto.randomUUID()}-${safeName}`;
  const { error } = await state.sb.storage.from("academy-course-materials").upload(path, file, {
    cacheControl: "3600",
    upsert: false,
  });
  if (error) throw error;
  const { data } = state.sb.storage.from("academy-course-materials").getPublicUrl(path);
  $("courseMaterialUrl").value = data.publicUrl;
  if (!$("courseMaterialLabel").value.trim()) $("courseMaterialLabel").value = file.name;
  toast("Archivo subido. Guarda el curso para asociarlo.", "success");
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

function renderLevelEditor(level = null) {
  $("levelId").value = level?.id || "";
  $("levelCode").value = level?.code || "";
  $("levelName").value = level?.name || "";
  $("levelMinXp").value = level?.min_xp ?? 0;
  $("levelSortOrder").value = level?.sort_order ?? Math.max(0, ...state.levels.map((item) => item.sort_order || 0)) + 1;
  $("levelActive").checked = level?.active ?? true;
}

function renderBadgeEditor(badge = null) {
  $("badgeId").value = badge?.id || "";
  $("badgeCode").value = badge?.code || "";
  $("badgeIcon").value = badge?.icon || "*";
  $("badgeName").value = badge?.name || "";
  $("badgeRuleType").value = badge?.rule_type || "completed_courses";
  $("badgeThreshold").value = badge?.threshold_int ?? "";
  $("badgeCourseCode").value = badge?.course_code || "";
  $("badgeSortOrder").value = badge?.sort_order ?? Math.max(0, ...state.badges.map((item) => item.sort_order || 0)) + 1;
  $("badgeActive").checked = badge?.active ?? true;
}

function renderConfigLists() {
  const badgeCourseSelect = $("badgeCourseCode");
  clear(badgeCourseSelect);
  const empty = element("option", "No aplica");
  empty.value = "";
  badgeCourseSelect.append(empty);
  state.courses.forEach((course) => {
    const option = element("option", `${course.code} - ${course.title}`);
    option.value = course.code;
    badgeCourseSelect.append(option);
  });

  const levelList = $("levelList");
  clear(levelList);
  state.levels.forEach((level) => {
    const item = element("article", "", "question-list-item");
    const actions = element("div", "", "admin-actions");
    const edit = element("button", "Editar", "secondary");
    edit.type = "button";
    edit.addEventListener("click", () => renderLevelEditor(level));
    const remove = element("button", "Eliminar", "danger");
    remove.type = "button";
    remove.addEventListener("click", () => deleteLevel(level.id).catch((error) => toast(error.message, "error", 9000)));
    actions.append(edit, remove);
    item.append(element("h4", `${level.sort_order}. ${level.name}`), element("p", `${level.code} - desde ${level.min_xp} XP - ${level.active ? "Activo" : "Inactivo"}`, "muted"), actions);
    levelList.append(item);
  });

  const badgeList = $("badgeList");
  clear(badgeList);
  state.badges.forEach((badge) => {
    const item = element("article", "", "question-list-item");
    const actions = element("div", "", "admin-actions");
    const edit = element("button", "Editar", "secondary");
    edit.type = "button";
    edit.addEventListener("click", () => renderBadgeEditor(badge));
    const remove = element("button", "Eliminar", "danger");
    remove.type = "button";
    remove.addEventListener("click", () => deleteBadge(badge.id).catch((error) => toast(error.message, "error", 9000)));
    actions.append(edit, remove);
    item.append(element("h4", `${badge.sort_order}. ${badge.icon || "*"} ${badge.name}`), element("p", `${badge.code} - ${badge.rule_type}${badge.threshold_int !== null ? ` ${badge.threshold_int}` : ""}${badge.course_code ? ` - ${badge.course_code}` : ""} - ${badge.active ? "Activa" : "Inactiva"}`, "muted"), actions);
    badgeList.append(item);
  });
}

async function loadConfig() {
  if (state.me.role !== "admin") throw new Error("Solo el administrador puede configurar niveles e insignias.");
  const [levels, badges] = await Promise.all([rpc("academy_admin_get_level_rules"), rpc("academy_admin_get_badge_rules")]);
  state.levels = levels || [];
  state.badges = badges || [];
  renderConfigLists();
  renderLevelEditor();
  renderBadgeEditor();
}

async function saveLevel() {
  await rpc("academy_admin_save_level_rule", {
    p_level_id: $("levelId").value || null,
    p_code: $("levelCode").value.trim().toLowerCase(),
    p_name: $("levelName").value.trim(),
    p_min_xp: Number($("levelMinXp").value),
    p_active: $("levelActive").checked,
    p_sort_order: Number($("levelSortOrder").value),
  });
  state.loaded.delete("config");
  await loadConfig();
  toast("Nivel guardado.", "success");
}

async function deleteLevel(levelId) {
  if (!window.confirm("Eliminar este nivel?")) return;
  await rpc("academy_admin_delete_level_rule", { p_level_id: levelId });
  state.loaded.delete("config");
  await loadConfig();
  toast("Nivel eliminado.", "success");
}

async function saveBadge() {
  const thresholdValue = $("badgeThreshold").value;
  await rpc("academy_admin_save_badge_rule", {
    p_badge_id: $("badgeId").value || null,
    p_code: $("badgeCode").value.trim().toLowerCase(),
    p_icon: $("badgeIcon").value.trim() || "*",
    p_name: $("badgeName").value.trim(),
    p_rule_type: $("badgeRuleType").value,
    p_threshold_int: thresholdValue === "" ? null : Number(thresholdValue),
    p_course_code: $("badgeCourseCode").value || null,
    p_active: $("badgeActive").checked,
    p_sort_order: Number($("badgeSortOrder").value),
  });
  state.loaded.delete("config");
  await loadConfig();
  toast("Insignia guardada.", "success");
}

async function deleteBadge(badgeId) {
  if (!window.confirm("Eliminar esta insignia?")) return;
  await rpc("academy_admin_delete_badge_rule", { p_badge_id: badgeId });
  state.loaded.delete("config");
  await loadConfig();
  toast("Insignia eliminada.", "success");
}

async function loadView(view, force = false) {
  if (!force && state.loaded.has(view)) return;
  if (view === "dashboard") await loadDashboard();
  if (view === "questions") await loadQuestions();
  if (view === "participants") await loadParticipants();
  if (view === "users") await loadUserManager();
  if (view === "recovery") await loadRecoveryRequests();
  if (view === "courses") await loadCourseDetails();
  if (view === "config") await loadConfig();
  state.loaded.add(view);
}

async function showView(view) {
  if (!ADMIN_VIEWS.has(view)) view = "dashboard";
  if (ADMIN_ONLY_VIEWS.has(view) && state.me.role !== "admin") view = "dashboard";
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
    users: "Mantenimiento de usuarios",
    recovery: "Recuperación de cuentas",
    courses: "Configuracion de cursos",
    config: "Niveles e insignias",
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
  $("newCourseBtn").addEventListener("click", () => renderCourseEditor());
  $("saveCourseBtn").addEventListener("click", () => saveCourse().catch((error) => toast(error.message, "error", 9000)));
  $("uploadCourseMaterialBtn").addEventListener("click", () => uploadCourseMaterial().catch((error) => toast(error.message, "error", 9000)));
  $("exportProgressBtn").addEventListener("click", exportProgress);
  $("newUserBtn").addEventListener("click", () => renderUserEditor());
  $("clearUserBtn").addEventListener("click", () => renderUserEditor());
  $("saveUserBtn").addEventListener("click", () => saveManagedUser().catch((error) => toast(error.message, "error", 9000)));
  $("setUserPasswordBtn").addEventListener("click", () => setManagedPassword().catch((error) => toast(error.message, "error", 9000)));
  $("newLevelBtn").addEventListener("click", () => renderLevelEditor());
  $("saveLevelBtn").addEventListener("click", () => saveLevel().catch((error) => toast(error.message, "error", 9000)));
  $("newBadgeBtn").addEventListener("click", () => renderBadgeEditor());
  $("saveBadgeBtn").addEventListener("click", () => saveBadge().catch((error) => toast(error.message, "error", 9000)));
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
    const { data, error } = await state.sb.functions.invoke("complete-temporary-password", {
      body: { new_password: password },
    });
    if (error) return toast(error.message, "error", 9000);
    if (data?.ok === false) return toast(data.error || "No se pudo actualizar la contrasena.", "error", 9000);
    $("adminPasswordDialog").close();
    $("adminNewPassword").value = "";
    $("adminConfirmPassword").value = "";
    toast("Contraseña actualizada.");
  });
  $("adminLogoutBtn").addEventListener("click", async () => {
    await state.sb.auth.signOut();
    clearSupabaseStorage();
    redirectToAcademy();
  });
}

async function init() {
  try {
    const authorized = await guardFocalAccess();
    if (!authorized) return;
    await loadBaseData();
    prepareAdminLayout();
    renderProfile();
    bindEvents();
    $("adminGuard").classList.add("hidden");
    $("adminApp").classList.remove("hidden");
    const pendingRequestsPromise = checkRecoveryAlerts({ notify: false })
      .catch((error) => console.error("No se pudo cargar el contador de solicitudes:", error));
    await showView(currentView());
    await pendingRequestsPromise;
    startRecoveryAlerts();
  } catch (error) {
    console.error(error);
    if (!$("adminApp").classList.contains("hidden")) {
      toast(error.message || "No se pudo cargar la información del panel focal.", "error", 12000);
      return;
    }
    showGuardError(error);
  }
}

init();
