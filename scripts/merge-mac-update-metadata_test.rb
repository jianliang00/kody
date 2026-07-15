# frozen_string_literal: true

require 'base64'
require 'digest'
require 'fileutils'
require 'minitest/autorun'
require 'open3'
require 'tmpdir'
require 'yaml'

class MergeMacUpdateMetadataTest < Minitest::Test
  SCRIPT = File.expand_path('merge-mac-update-metadata.rb', __dir__)

  def test_refreshes_final_artifact_integrity_and_prefers_x64_zip_for_legacy_clients
    Dir.mktmpdir('kody-update-metadata') do |root|
      inputs = %w[arm64 x64].map do |arch|
        directory = File.join(root, arch)
        FileUtils.mkdir_p(directory)
        files = %w[dmg zip].map do |extension|
          name = "Kody-1.2.3-mac-#{arch}.#{extension}"
          File.binwrite(File.join(directory, name), "final-#{arch}-#{extension}\0payload")
          { 'url' => name, 'sha512' => 'stale', 'size' => 1 }
        end
        metadata = {
          'version' => '1.2.3',
          'files' => files,
          'path' => files.first.fetch('url'),
          'sha512' => 'stale',
          'releaseDate' => arch == 'arm64' ? '2026-01-01T00:00:00Z' : '2026-01-02T00:00:00Z'
        }
        path = File.join(directory, 'latest-mac.yml')
        File.write(path, YAML.dump(metadata))
        path
      end

      output = File.join(root, 'latest-mac.yml')
      stdout, stderr, status = Open3.capture3('ruby', SCRIPT, output, *inputs)
      assert status.success?, "#{stdout}\n#{stderr}"

      merged = YAML.safe_load(File.read(output), aliases: false)
      assert_equal 'Kody-1.2.3-mac-x64.zip', merged.fetch('path')
      assert_equal '2026-01-02T00:00:00Z', merged.fetch('releaseDate')
      assert_equal 4, merged.fetch('files').length

      merged.fetch('files').each do |file|
        arch = file.fetch('url').include?('arm64') ? 'arm64' : 'x64'
        artifact = File.join(root, arch, file.fetch('url'))
        expected_hash = Base64.strict_encode64(Digest::SHA512.file(artifact).digest)
        assert_equal File.size(artifact), file.fetch('size')
        assert_equal expected_hash, file.fetch('sha512')
      end
      x64_zip = merged.fetch('files').find { |file| file.fetch('url').end_with?('x64.zip') }
      assert_equal x64_zip.fetch('sha512'), merged.fetch('sha512')
    end
  end
end
