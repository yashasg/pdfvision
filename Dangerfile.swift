import Danger
import Foundation

let danger = Danger()
let changedFiles = danger.git.createdFiles + danger.git.modifiedFiles
let sourceChanges = changedFiles.filter {
    $0.hasPrefix("Sources/") && $0.hasSuffix(".swift")
}

let testChanges = changedFiles.filter {
    $0.hasPrefix("Tests/") && $0.hasSuffix(".swift")
}

if !sourceChanges.isEmpty, testChanges.isEmpty {
    warn("Swift source changed without accompanying test changes.")
}

if changedFiles.count > 30 {
    warn("This pull request changes more than 30 files; consider splitting it into smaller changes.")
}

if let github = danger.github {
    let pullRequest = github.pullRequest
    let title = pullRequest.title.lowercased()
    let body = pullRequest.body?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let lineChanges = (pullRequest.additions ?? 0) + (pullRequest.deletions ?? 0)

    if title.hasPrefix("wip") || title.contains("[wip]") {
        warn("Mark the pull request as a draft instead of using WIP in its title.")
    }

    if body.count < 20 {
        warn("Add a short pull request description covering the change and its validation.")
    }

    if lineChanges > 800 {
        warn("This pull request changes more than 800 lines; consider splitting it into smaller changes.")
    }
}
