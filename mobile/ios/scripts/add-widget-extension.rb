#!/usr/bin/env ruby
# Idempotently add the iOS 18 widget extension. Kept as a script so future pbxproj merges can be replayed.
require 'xcodeproj'

project_path = File.expand_path('../App/App.xcodeproj', __dir__)
project = Xcodeproj::Project.open(project_path)
app = project.targets.find { |target| target.name == 'App' } or abort 'App target missing'
abort 'T2 project-level EXO_BUNDLE_ID is missing' unless project.build_configurations.all? { |config| config.build_settings.key?('EXO_BUNDLE_ID') }

app_group = project.main_group.find_subpath('App', false)
shared = project.main_group.find_subpath('Shared', false) || app_group.find_subpath('Shared', false) || project.main_group.find_subpath('Shared', true)
if app_group.children.include?(shared)
  app_group.children.delete(shared)
  project.main_group.children << shared
end
shared.set_source_tree('<group>')
shared.set_path('Shared')
widgets = project.main_group.find_subpath('ExoWidgets', false) || app_group.find_subpath('ExoWidgets', false) || project.main_group.find_subpath('ExoWidgets', true)
if app_group.children.include?(widgets)
  app_group.children.delete(widgets)
  project.main_group.children << widgets
end
widgets.set_source_tree('<group>')
widgets.set_path('ExoWidgets')

reference = lambda do |group, name, path|
  group.files.find { |file| file.path == path } || group.new_file(path).tap { |file| file.name = name }
end

extension = project.targets.find { |target| target.name == 'ExoWidgets' }
unless extension
  extension = project.new_target(:app_extension, 'ExoWidgets', :ios, '18.0')
  project.root_object.attributes['TargetAttributes'] ||= {}
  project.root_object.attributes['TargetAttributes'][extension.uuid] = { 'CreatedOnToolsVersion' => '16.0', 'ProvisioningStyle' => 'Automatic' }
end
# xcodeproj's target template adds a hard-coded iPhoneOS18.0 Foundation.framework path.
# Swift auto-links Foundation; remove that stale SDK reference for Xcode 26 and 27.
extension.frameworks_build_phase.files.dup.each do |build_file|
  file = build_file.file_ref
  next unless file&.path&.end_with?('/Foundation.framework')
  build_file.remove_from_project
  file.remove_from_project
end
frameworks_group = project.main_group.children.find { |child| child.isa == 'PBXGroup' && child.name == 'Frameworks' }
if frameworks_group && frameworks_group.children.all? { |child| child.isa == 'PBXGroup' && child.children.empty? }
  frameworks_group.children.dup.each(&:remove_from_project)
  frameworks_group.remove_from_project
end

[[shared, 'RecordingActivityAttributes.swift', 'RecordingActivityAttributes.swift'],
 [shared, 'RecordingIntents.swift', 'RecordingIntents.swift']].each do |group, name, path|
  file = reference.call(group, name, path)
  app.source_build_phase.add_file_reference(file) unless app.source_build_phase.files_references.include?(file)
  extension.source_build_phase.add_file_reference(file) unless extension.source_build_phase.files_references.include?(file)
end
widget_source = reference.call(widgets, 'ExoWidgets.swift', 'ExoWidgets.swift')
extension.source_build_phase.add_file_reference(widget_source) unless extension.source_build_phase.files_references.include?(widget_source)
reference.call(widgets, 'Info.plist', 'Info.plist')
privacy = reference.call(widgets, 'PrivacyInfo.xcprivacy', 'PrivacyInfo.xcprivacy')
extension.resources_build_phase.add_file_reference(privacy) unless extension.resources_build_phase.files_references.include?(privacy)

extension.build_configurations.each do |config|
  config.build_settings.merge!({
    'APPLICATION_EXTENSION_API_ONLY' => 'YES',
    'CODE_SIGN_STYLE' => 'Automatic',
    'CURRENT_PROJECT_VERSION' => '1',
    'GENERATE_INFOPLIST_FILE' => 'NO',
    'INFOPLIST_FILE' => 'ExoWidgets/Info.plist',
    'IPHONEOS_DEPLOYMENT_TARGET' => '18.0',
    'LD_RUNPATH_SEARCH_PATHS' => ['$(inherited)', '@executable_path/Frameworks', '@executable_path/../../Frameworks'],
    'MARKETING_VERSION' => '1.0',
    'PRODUCT_BUNDLE_IDENTIFIER' => '$(EXO_BUNDLE_ID).widgets',
    'PRODUCT_NAME' => '$(TARGET_NAME)',
    'SKIP_INSTALL' => 'YES',
    'SWIFT_ACTIVE_COMPILATION_CONDITIONS' => config.name == 'Debug' ? 'DEBUG EXO_WIDGET_EXTENSION' : 'EXO_WIDGET_EXTENSION',
    'SWIFT_VERSION' => '5.0',
    'TARGETED_DEVICE_FAMILY' => '1,2'
  })
  config.build_settings.delete('CODE_SIGN_ENTITLEMENTS')
end

unless app.dependencies.any? { |dependency| dependency.target == extension }
  app.add_dependency(extension)
end
embed = app.copy_files_build_phases.find { |phase| phase.name == 'Embed App Extensions' }
unless embed
  embed = project.new(Xcodeproj::Project::Object::PBXCopyFilesBuildPhase)
  embed.name = 'Embed App Extensions'
  embed.dst_subfolder_spec = '13'
  app.build_phases << embed
end
# The Debug location spike edits App.app/Info.plist. Xcode needs the appex copy before that
# phase; placing it afterwards creates a Copy -> script -> ProcessInfoPlist -> Copy cycle.
location_phase = app.build_phases.find { |phase| phase.display_name == 'Location spike Info.plist (Debug only)' }
if location_phase && app.build_phases.index(embed) > app.build_phases.index(location_phase)
  app.build_phases.delete(embed)
  app.build_phases.insert(app.build_phases.index(location_phase), embed)
end
unless embed.files_references.include?(extension.product_reference)
  build_file = embed.add_file_reference(extension.product_reference)
  build_file.settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }
end

abort 'keep objectVersion = 60 for Xcode 26.6' unless project.object_version == '60'
project.save
