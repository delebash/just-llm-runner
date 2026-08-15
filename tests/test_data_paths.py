# SPDX-License-Identifier: MIT
"""THE family data-location policy (user ruling 2026-08-14): the user's
explicit choice first, a `data/` folder beside the app by default, and the OS
app-data dir ONLY when the install directory can't be written."""

from llm_runner.platform.data_paths import install_dir, resolve_data_dir


def test_env_var_is_the_users_choice_and_always_wins(tmp_path):
    chosen = tmp_path / "somewhere" / "the-user-picked"
    got = resolve_data_dir(
        app_name="JustVoice", env_var="JV_DATA",
        source_root=tmp_path / "checkout",
        env={"JV_DATA": str(chosen)},
    )
    assert got == chosen
    # And nothing was created beside the app just by asking.
    assert not (tmp_path / "checkout" / "data").exists()


def test_default_is_data_beside_the_app(tmp_path):
    root = tmp_path / "checkout"
    root.mkdir()
    got = resolve_data_dir(
        app_name="JustVoice", env_var="JV_DATA", source_root=root, env={},
    )
    assert got == root / "data"


def test_blank_env_var_is_not_a_choice(tmp_path):
    root = tmp_path / "checkout"
    root.mkdir()
    got = resolve_data_dir(
        app_name="JustVoice", env_var="JV_DATA", source_root=root,
        env={"JV_DATA": "   "},
    )
    assert got == root / "data"


def test_os_dir_only_when_the_install_dir_is_not_writable(tmp_path, monkeypatch):
    """The last-resort arm: a Program-Files-style read-only install. Never a
    preference — only reached when the probe fails."""
    import llm_runner.platform.data_paths as dp

    monkeypatch.setattr(dp, "_is_writable", lambda p: False)
    got = resolve_data_dir(
        app_name="JustVoice", env_var="JV_DATA",
        source_root=tmp_path / "readonly", env={},
    )
    assert got != (tmp_path / "readonly" / "data")
    assert "JustVoice" in str(got)


def test_no_source_root_and_not_frozen_falls_back(tmp_path):
    """A host that passes no checkout root (bare library use) still resolves
    honestly rather than inventing a path."""
    got = resolve_data_dir(app_name="JustWrite", env_var="JW_DATA", env={})
    assert "JustWrite" in str(got)


def test_install_dir_is_the_exe_folder_when_frozen(tmp_path, monkeypatch):
    exe = tmp_path / "app" / "justvoice.exe"
    exe.parent.mkdir(parents=True)
    exe.write_bytes(b"x")
    monkeypatch.setattr("sys.frozen", True, raising=False)
    monkeypatch.setattr("sys.executable", str(exe))
    assert install_dir(source_root=tmp_path / "ignored") == exe.parent


def test_frozen_default_lands_beside_the_executable(tmp_path, monkeypatch):
    exe = tmp_path / "app" / "justvoice.exe"
    exe.parent.mkdir(parents=True)
    exe.write_bytes(b"x")
    monkeypatch.setattr("sys.frozen", True, raising=False)
    monkeypatch.setattr("sys.executable", str(exe))
    got = resolve_data_dir(app_name="JustVoice", env_var="JV_DATA", env={})
    assert got == exe.parent / "data"


def test_probe_leaves_nothing_behind(tmp_path):
    root = tmp_path / "checkout"
    root.mkdir()
    resolve_data_dir(app_name="X", env_var="X_DATA", source_root=root, env={})
    assert list((root / "data").iterdir()) == []


def test_the_two_apps_resolve_to_their_own_folders(tmp_path):
    """Same policy, per-app roots — no shared/global location."""
    jv_root, jw_root = tmp_path / "jv", tmp_path / "jw"
    jv_root.mkdir()
    jw_root.mkdir()
    jv = resolve_data_dir(app_name="JustVoice", env_var="JUSTVOICE_DATA_DIR",
                          source_root=jv_root, env={})
    jw = resolve_data_dir(app_name="JustWrite", env_var="JUSTWRITE_DATA_DIR",
                          source_root=jw_root, env={})
    assert jv == jv_root / "data"
    assert jw == jw_root / "data"
    assert jv != jw
