#!/usr/bin/env ruby
# frozen_string_literal: true

require 'date'
require 'fileutils'
require 'yaml'

output, *inputs = ARGV
abort 'usage: merge-mac-update-metadata.rb OUTPUT INPUT...' unless output && inputs.length >= 2

documents = inputs.map do |path|
  value = YAML.safe_load(
    File.read(path),
    permitted_classes: [Date, Time],
    aliases: false
  )
  abort "invalid update metadata: #{path}" unless value.is_a?(Hash) && value['files'].is_a?(Array)
  value
end

versions = documents.map { |document| document['version'] }.uniq
abort "metadata versions do not match: #{versions.join(', ')}" unless versions.length == 1

files = documents
  .flat_map { |document| document.fetch('files') }
  .uniq { |file| file.fetch('url') }
  .sort_by { |file| file.fetch('url') }

%w[arm64 x64].each do |arch|
  abort "metadata does not contain a #{arch} update" unless files.any? { |file| file.fetch('url').include?(arch) }
end

fallback = files.find { |file| file.fetch('url').include?('x64') } || files.first
merged = documents.first.merge(
  'files' => files,
  # Kept for compatibility with older updater clients. Current clients select
  # the architecture-specific entry from `files`.
  'path' => fallback.fetch('url'),
  'sha512' => fallback.fetch('sha512')
)
release_dates = documents.map { |document| document['releaseDate'] }.compact
merged['releaseDate'] = release_dates.max unless release_dates.empty?

FileUtils.mkdir_p(File.dirname(output))
yaml = YAML.dump(merged).sub(/\A---\s*\n/, '')
File.write(output, yaml)
puts "Merged #{files.length} macOS update files for Kody #{versions.first} into #{output}"
