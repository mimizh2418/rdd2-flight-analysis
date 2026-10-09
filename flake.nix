{
  description = "Pinned development tools and RDD2 models; npm and uv manage project dependencies";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/fd1462031fdee08f65fd0b4c6b64e22239a77870";
    modelica-models = {
      url = "github:CogniPilot/modelica_models/3d6204e7a907e452e08c46cd63352d6365089a38";
      # Fetch only library sources, without the upstream OpenModelica/Rust development environment.
      flake = false;
    };
  };

  outputs =
    { nixpkgs, modelica-models, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forSystems = nixpkgs.lib.genAttrs systems;
      environments = forSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          tools = [
            pkgs.nodejs_22
            pkgs.python311
            pkgs.uv
            pkgs.gitMinimal
            pkgs.nixfmt
            pkgs.cacert
          ];
          browserTools = pkgs.lib.optionals pkgs.stdenv.isLinux [ pkgs.chromium ];

          # uv keeps installing the locked wheels. Their native libraries need a search path on NixOS.
          nativeLibraries = pkgs.lib.makeLibraryPath [
            pkgs.stdenv.cc.cc.lib
            pkgs.zlib
          ];
          environment = pkgs.writeShellScript "rdd2-environment" ''
            export UV_PYTHON=${pkgs.python311}/bin/python3
            export UV_PYTHON_DOWNLOADS=never
            export UV_PYTHON_PREFERENCE=only-system
            export UV_PROJECT_ENVIRONMENT="$PWD/.venv-nix"
            export RDD2_MODELICA_ROOT=${modelica-models}
            export RDD2_MODELICA_REVISION=${modelica-models.rev}
            export SSL_CERT_FILE="''${SSL_CERT_FILE:-${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt}"
            ${pkgs.lib.optionalString pkgs.stdenv.isLinux ''
              export LD_LIBRARY_PATH="${nativeLibraries}''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
            ''}
          '';
          browserEnvironment = pkgs.lib.optionalString pkgs.stdenv.isLinux ''
            export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=${pkgs.chromium}/bin/chromium
          '';

          # Commands operate on the working tree, leaving logs and dependency directories writable.
          action =
            name:
            {
              text,
              browser ? false,
              frontend ? true,
            }:
            pkgs.writeShellApplication {
              name = "rdd2-${name}";
              runtimeInputs = tools ++ pkgs.lib.optionals browser browserTools;
              text = ''
                if [[ ! -f package.json || ! -f tools/rdd2_simulate.py ]]; then
                  echo "Run this command from the rdd2-flight-analysis repository root." >&2
                  exit 1
                fi
                # shellcheck source=/dev/null
                source ${environment}
                ${pkgs.lib.optionalString browser browserEnvironment}
                ${pkgs.lib.optionalString frontend ''
                  if [[ ! -d node_modules ]]; then
                    npm ci
                  fi
                ''}
                ${text}
              '';
            };

          commands = {
            install = action "install" {
              frontend = false;
              text = ''
                npm ci
                exec uv sync --locked --extra simulation "$@"
              '';
            };
            dev = action "dev" { text = ''exec npm run dev -- "$@"''; };
            build = action "build" { text = ''exec npm run build -- "$@"''; };
            preview = action "preview" { text = ''exec npm run preview -- "$@"''; };
            serve = action "serve" {
              text = ''
                npm run build
                exec npm run preview -- "$@"
              '';
            };
            test-core = action "test-core" { text = ''exec npm test -- "$@"''; };
            test-python = action "test-python" {
              frontend = false;
              text = ''exec npm run test:python -- "$@"'';
            };
            test-browser = action "test-browser" {
              browser = true;
              text = ''
                npm run build
                export RDD2_PREVIEW=1
                exec npm run test:browser -- "$@"
              '';
            };
            test = action "test" {
              browser = true;
              text = ''
                npm test
                npm run test:python
                npm run build
                export RDD2_PREVIEW=1
                exec npm run test:browser -- "$@"
              '';
            };
            format = action "format" {
              text = ''
                npm run format
                npm run format:python
                exec nixfmt flake.nix
              '';
            };
            check = action "check" {
              text = ''
                npm run format:check
                npm run format:python:check
                exec nixfmt --check flake.nix
              '';
            };
            simulate = action "simulate" {
              frontend = false;
              text = ''exec npm run simulate -- "$@"'';
            };
            service = action "service" {
              frontend = false;
              text = ''exec npm run service -- "$@"'';
            };
            convert-csv = action "convert-csv" {
              frontend = false;
              text = ''exec npm run convert:csv -- "$@"'';
            };
            benchmark = action "benchmark" { text = ''exec npm run benchmark -- "$@"''; };
          };
        in
        {
          inherit commands;
          formatter = pkgs.nixfmt;
          shells = {
            default = pkgs.mkShell {
              packages = tools ++ builtins.attrValues commands;
              shellHook = "source ${environment}";
            };
            browser = pkgs.mkShell {
              packages = tools ++ builtins.attrValues commands ++ browserTools;
              shellHook = ''
                source ${environment}
                ${browserEnvironment}
              '';
            };
          };
        }
      );
    in
    {
      devShells = forSystems (system: environments.${system}.shells);
      formatter = forSystems (system: environments.${system}.formatter);
      apps = forSystems (
        system:
        let
          apps = nixpkgs.lib.mapAttrs (name: package: {
            type = "app";
            program = "${package}/bin/rdd2-${name}";
            meta.description = "RDD2 ${name} using pinned development tools";
          }) environments.${system}.commands;
        in
        apps // { default = apps.dev; }
      );
    };
}
