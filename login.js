document.addEventListener("DOMContentLoaded", function () {

    /* =====================================================
       SUPABASE CONFIG
       Same project as app.js — duplicated here since this
       is a separate standalone page loaded before login.
    ===================================================== */

    const SUPABASE_URL =
        "https://zepbgjlliklvwyipahin.supabase.co";

    const SUPABASE_KEY =
        "sb_publishable_HJYQXc8ZnQMJBhxHzxAp6Q_dMtY1NwW";

    const SESSION_KEY =
        "attendance_admin_session";


    /* =====================================================
       TOAST (mirrors the dashboard's toast for consistency)
    ===================================================== */

    function showToast(message) {

        const toast =
            document.getElementById("toast");


        if (!toast) {
            return;
        }


        toast.textContent = message;

        toast.classList.add("show");


        setTimeout(
            function () {

                toast.classList.remove("show");

            },
            3000
        );

    }


    /* =====================================================
       PASSWORD VISIBILITY TOGGLE
    ===================================================== */

    const passwordInput =
        document.getElementById("loginPassword");


    const toggleBtn =
        document.getElementById("togglePasswordBtn");


    if (toggleBtn && passwordInput) {

        toggleBtn.addEventListener(
            "click",
            function () {

                const isHidden =
                    passwordInput.type === "password";


                passwordInput.type =
                    isHidden ? "text" : "password";


                toggleBtn.textContent =
                    isHidden ? "🙈" : "👁️";

            }
        );

    }


    /* =====================================================
       LOGIN FORM SUBMIT
    ===================================================== */

    const loginForm =
        document.getElementById("loginForm");


    const submitBtn =
        document.getElementById("loginSubmitBtn");


    const errorText =
        document.getElementById("loginError");


    const rememberMeCheckbox =
        document.getElementById("rememberMeCheckbox");


    if (loginForm) {

        loginForm.addEventListener(
            "submit",
            async function (event) {

                event.preventDefault();


                if (errorText) {

                    errorText.textContent = "";

                    errorText.classList.remove("show");

                }


                const email =
                    document
                        .getElementById("loginEmail")
                        .value
                        .trim();


                const password =
                    passwordInput.value;


                if (!email || !password) {

                    return;

                }


                submitBtn.disabled = true;

                submitBtn.textContent =
                    "Signing in...";


                try {

                    const response =
                        await fetch(
                            SUPABASE_URL +
                            "/auth/v1/token?grant_type=password",
                            {
                                method: "POST",

                                headers: {
                                    "apikey": SUPABASE_KEY,

                                    "Content-Type":
                                        "application/json"
                                },

                                body: JSON.stringify({
                                    email: email,
                                    password: password
                                })
                            }
                        );


                    const data =
                        await response.json();


                    if (!response.ok) {

                        throw new Error(
                            data.error_description ||
                            data.msg ||
                            "Invalid email or password."
                        );

                    }


                    const session = {
                        access_token:
                            data.access_token,

                        refresh_token:
                            data.refresh_token,

                        expires_at:
                            Date.now() +
                            (data.expires_in * 1000),

                        email:
                            data.user &&
                            data.user.email
                    };


                    const rememberMe =
                        rememberMeCheckbox &&
                        rememberMeCheckbox.checked;


                    const targetStorage =
                        rememberMe
                            ? localStorage
                            : sessionStorage;

                    const otherStorage =
                        rememberMe
                            ? sessionStorage
                            : localStorage;


                    targetStorage.setItem(
                        SESSION_KEY,
                        JSON.stringify(session)
                    );

                    /* Clear any stale session in the other
                       storage so the two never disagree. */

                    otherStorage.removeItem(
                        SESSION_KEY
                    );


                    showToast(
                        "Signed in successfully."
                    );


                    window.location.href =
                        "index.html";


                } catch (error) {

                    console.error(
                        "Login error:",
                        error
                    );


                    if (errorText) {

                        errorText.textContent =
                            error.message ||
                            "Unable to sign in. Please try again.";

                        errorText.classList.add(
                            "show"
                        );

                    }


                    submitBtn.disabled = false;

                    submitBtn.textContent =
                        "Sign In";

                }

            }
        );

    }

});
