local hh    = require('spec.spec_helper')
local azk   = require('azk')
local app   = require('azk.app')
local shell = require('azk.cli.shell')
local utils = require('azk.utils')
local fs    = require('azk.utils.fs')

local path    = azk.path
local command = require('azk.cli.commands.service')

describe("Azk #cli #commandservice", function()
  local i18n_f      = azk.i18n.module("command_service")
  local i18n_app_f  = azk.i18n.module("app")
  local i18n_prov_f = azk.i18n.module("provision")

  after_each(function()
    hh.remove_test_images()
  end)

  it("should return 1 with blank invocation", function()
    local result = command.run()
    assert.is.equal(result, 1)
  end)

  it("should require azkfile.json", function()
    local project = utils.tmp_dir()
    fs.cd(project, function()
      local output = shell.capture_io(function()
        command.run("any")
      end)

      local msg = i18n_app_f("no_such", { file = azk.manifest })
      assert.has_log("error", msg, output.stderr)
    end)
  end)

  describe("in a valid project", function()
    local tmp_dir = hh.tmp_dir()
    local project = path.join(tmp_dir, 'project')
    local box     = path.join(tmp_dir, 'test-box')
    local images = {}

    setup(function()
      fs.mkdir(project)
      fs.cp_r(
        hh.fixture_path("base_azkfile.json"),
        path.join(project, azk.manifest)
      )
      fs.cp_r(hh.fixture_path("test-box"), box)
    end)

    it("should provision image-box and image-app before start", function()
      local _, app_data = app.new(project)
      fs.cd(project, function()
        local output = shell.capture_io(function()
          command.run("web", "start")
        end)

        assert.has_log("info", i18n_prov_f("check", app_data), output.stderr)
      end)
    end)
  end)
end)
